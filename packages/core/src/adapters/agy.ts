import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { encodeWithWin32 } from '../input.js';
import { readAgyTranscript } from './agy-transcript.js';
import type { AgentAdapter, HookSignal } from './types.js';

export { readAgyTranscript };

/**
 * Como enviar símbolos que o agy descarta na entrada (×, emoji, aspas curvas).
 * 'file': grava o prompt num arquivo e pede para o agy ler. 'keys': envia eventos de tecla win32-input.
 * A Task 12 decide o valor com um teste no agy real.
 */
export const AGY_SYMBOL_STRATEGY = 'file' as 'file' | 'keys';

// Letras (com acentos), números, espaços, ASCII imprimível e ° º ª chegam inteiros ao agy (fase 0).
const SAFE_FOR_AGY = /^[\p{L}\p{M}\p{N}\s!-~°ºª]$/u;

export function isUnsafeForAgy(char: string): boolean {
  return !SAFE_FOR_AGY.test(char);
}

const stopPayload = z.object({
  conversationId: z.string().optional(),
  transcriptPath: z.string().optional(),
  fullyIdle: z.boolean().optional(),
});

export function agyHookGroup(command: string): object {
  // O Stop do agy precisa de forma plana, sem matcher (agy 1.3.2).
  return { Stop: [{ type: 'command', command, timeout: 10 }] };
}

function writePromptFile(text: string, ctx: { cwd: string; askId: string }): string {
  // Dentro da pasta do projeto: ler fora dela dispara o diálogo "Allow access to this file?".
  const dir = join(ctx.cwd, '.orquestra', 'prompts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(ctx.cwd, '.orquestra', '.gitignore'), '*\n');
  const file = join(dir, `${ctx.askId}.md`);
  writeFileSync(file, text, 'utf8');
  return `Leia o arquivo ${file.replaceAll('\\', '/')} e atenda ao pedido escrito nele. Responda aqui.`;
}

export const agyAdapter: AgentAdapter = {
  kind: 'agy',
  acceptsPrompts: true,
  screenRules: [
    { pattern: /Requesting permission for:|Allow access to this file\?|Do you trust the contents of this project\?/, signal: 'waiting' },
    { pattern: /Interrupted · What should Antigravity CLI do instead\?/, signal: 'interrupted', scope: 'new-occurrence' },
  ],
  // Hooks vêm do arquivo global (agy não tem config por sessão): ver agy-hooks.ts.
  // O histórico do agy é global: --conversation funciona em qualquer pasta.
  launch: (ctx) => ({ command: 'agy', args: ctx.resumeSessionId ? ['--conversation', ctx.resumeSessionId] : [], env: {} }),
  interpretHook: (event, payload): HookSignal => {
    if (event !== 'Stop') return { kind: 'ignored' };
    const parsed = stopPayload.safeParse(payload);
    if (!parsed.success || parsed.data.fullyIdle === false) return { kind: 'ignored' };
    return {
      kind: 'turn-end',
      text: null,
      transcriptPath: parsed.data.transcriptPath ?? null,
      agentSessionId: parsed.data.conversationId ?? null,
    };
  },
  readTranscript: readAgyTranscript,
  preparePrompt: (text, ctx) => {
    if (AGY_SYMBOL_STRATEGY === 'file' && [...text].some(isUnsafeForAgy)) return writePromptFile(text, ctx);
    return text;
  },
  ...(AGY_SYMBOL_STRATEGY === 'keys' ? { encodeInput: (body: string) => encodeWithWin32(body, isUnsafeForAgy) } : {}),
};
