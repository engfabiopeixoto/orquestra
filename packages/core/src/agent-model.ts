import { existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelObservation } from '@orquestra/shared';
import { z } from 'zod';

export type { ModelObservation };

/** Só o fim do arquivo: transcrições longas passam de dezenas de MB e o modelo atual está nas últimas linhas. */
const TAIL_BYTES = 512 * 1024;

async function readTailLines(path: string, bytes = TAIL_BYTES): Promise<string[] | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // A primeira linha pode ter começado antes do trecho lido.
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function lastObservation<T>(lines: string[], schema: z.ZodType<T>, pick: (row: T) => ModelObservation | null): ModelObservation | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const text = lines[index]!;
    if (!text.trim()) continue;
    let json: unknown;
    try { json = JSON.parse(text); } catch { continue; }
    const parsed = schema.safeParse(json);
    if (!parsed.success) continue;
    const observed = pick(parsed.data);
    if (observed) return observed;
  }
  return null;
}

const timestampOf = (value: string | undefined): number => {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
};

const claudeAssistantLine = z.object({
  type: z.literal('assistant'),
  isSidechain: z.boolean().optional(),
  timestamp: z.string().optional(),
  message: z.object({ model: z.string().min(1) }),
});

/** Modelo da última resposta do Claude na transcrição (~/.claude/projects/<pasta>/<sessão>.jsonl). */
export async function readClaudeModel(transcriptPath: string): Promise<ModelObservation | null> {
  const lines = await readTailLines(transcriptPath);
  if (!lines) return null;
  return lastObservation(lines, claudeAssistantLine, (row) => {
    // Subagentes podem rodar em outro modelo; respostas sintéticas (erro, interrupção) não dizem o modelo.
    if (row.isSidechain || row.message.model === '<synthetic>') return null;
    return { model: row.message.model, at: timestampOf(row.timestamp) };
  });
}

const codexTurnContextLine = z.object({
  type: z.literal('turn_context'),
  timestamp: z.string().optional(),
  payload: z.object({ model: z.string().min(1) }),
});

/** Modelo do último turno no rollout do Codex (turn_context.model). */
export async function readCodexModel(rolloutPath: string): Promise<ModelObservation | null> {
  const lines = await readTailLines(rolloutPath);
  if (!lines) return null;
  return lastObservation(lines, codexTurnContextLine, (row) => ({ model: row.payload.model, at: timestampOf(row.timestamp) }));
}

/** Pasta do projeto como o Claude Code nomeia: cada caractere fora de [A-Za-z0-9] vira hífen. */
export const claudeProjectDirName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

export function findClaudeTranscript(claudeDir: string, cwd: string, sessionId: string): string | null {
  const projects = join(claudeDir, 'projects');
  const file = `${sessionId}.jsonl`;
  const direct = join(projects, claudeProjectDirName(cwd), file);
  if (existsSync(direct)) return direct;
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return null; }
  for (const dir of dirs) {
    const candidate = join(projects, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
