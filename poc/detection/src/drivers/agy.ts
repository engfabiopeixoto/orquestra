import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RELAY_PATH, type AgentDriver, type TurnSignal } from '../types.js';

const stopPayload = z.object({
  conversationId: z.string().optional(),
  transcriptPath: z.string().optional(),
  fullyIdle: z.boolean().optional(),
});

const plannerResponse = z.object({
  step_index: z.number(),
  source: z.literal('MODEL'),
  type: z.literal('PLANNER_RESPONSE'),
  content: z.string(),
  tool_calls: z.array(z.unknown()).optional(),
});

const userInput = z.object({ type: z.literal('USER_INPUT') });

const DOWN = '\x1b[B';

// A transcrição é gravada de forma assíncrona: tentamos de novo por até 2 s.
const TRANSCRIPT_RETRIES = 10;
const TRANSCRIPT_RETRY_MS = 200;

// O agy divide o comando do hook nos espaços e ignora aspas (agy 1.3.2), então o caminho não pode ter espaço.
export function agyHooksJson(relayPath: string): object {
  if (/\s/.test(relayPath)) throw new Error(`Caminho do relay com espaço: ${relayPath}. O agy não aceita aspas no comando do hook.`);
  return { orquestra: { Stop: [{ type: 'command', command: `node ${relayPath} agy Stop`, timeout: 10 }] } };
}

export async function readAgyTranscript(
  path: string,
  afterStepIndex: number,
): Promise<{ text: string; stepIndex: number } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  // Só vale a resposta final do turno atual: depois do último prompt do usuário e sem chamada de ferramenta.
  let latest: { text: string; stepIndex: number } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    if (userInput.safeParse(json).success) {
      latest = null;
      continue;
    }
    const parsed = plannerResponse.safeParse(json);
    if (!parsed.success || parsed.data.content.trim() === '' || parsed.data.step_index <= afterStepIndex) continue;
    if (parsed.data.tool_calls && parsed.data.tool_calls.length > 0) continue;
    latest = { text: parsed.data.content, stepIndex: parsed.data.step_index };
  }
  return latest;
}

export function createAgyDriver(): AgentDriver {
  let lastDeliveredStep = -1;
  return {
    kind: 'agy',
    pasteMode: 'bracketed',
    autoAnswers: [
      // O padrão do diálogo é "Yes, I trust this folder": só confirma.
      { whenScreen: /Do you trust the contents of this project\?/, keys: ['\r'] },
      // Enter escolhe "1. Yes" (só esta vez); a opção 3 gravaria a permissão no settings.json do usuário.
      // Só nos cenários que precisam de ferramenta: aprovar tudo deixou o agy vasculhar o ambiente e ler outras rodadas.
      { whenScreen: /Requesting permission for:/, keys: ['\r'], onlyWhen: (scenario) => scenario?.allowTools === true },
      // Negar com Esc interrompe o turno inteiro e o Stop não dispara: escolhemos "4. No, cancel" pelas setas.
      { whenScreen: /Requesting permission for:/, keys: [DOWN, DOWN, DOWN, '\r'], onlyWhen: (scenario) => scenario?.allowTools !== true },
      // Leitura fora da pasta de trabalho: sempre negada ("3. No, deny access").
      { whenScreen: /Allow access to this file\?/, keys: [DOWN, DOWN, '\r'] },
    ],
    launch: (ctx) => {
      const relayCopy = join(ctx.sessionDir, 'hook-relay.mjs').replaceAll('\\', '/');
      copyFileSync(RELAY_PATH, relayCopy);
      mkdirSync(join(ctx.workDir, '.agents'), { recursive: true });
      writeFileSync(join(ctx.workDir, '.agents', 'hooks.json'), JSON.stringify(agyHooksJson(relayCopy), null, 2));
      return { name: 'agy', args: [], env: {} };
    },
    interpret: (envelope): TurnSignal => {
      if (envelope.event !== 'Stop') return { kind: 'ignored' };
      const parsed = stopPayload.safeParse(envelope.payload);
      if (!parsed.success || parsed.data.fullyIdle === false) return { kind: 'ignored' };
      return {
        kind: 'turn-end',
        text: null,
        transcriptPath: parsed.data.transcriptPath ?? null,
        sessionId: parsed.data.conversationId ?? null,
      };
    },
    readTranscript: async (path) => {
      for (let attempt = 0; attempt < TRANSCRIPT_RETRIES; attempt++) {
        const found = await readAgyTranscript(path, lastDeliveredStep);
        if (found) {
          lastDeliveredStep = found.stepIndex;
          return found.text;
        }
        await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_RETRY_MS));
      }
      return null;
    },
  };
}
