import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agyModelId, type ModelAgent, type ModelObservation } from '@orquestra/shared';
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

/** Onde o agy guarda o modelo padrão: o /model grava aqui o nome de exibição (agy 1.5.3). */
export const DEFAULT_AGY_SETTINGS_FILE = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

const agySettings = z.object({ model: z.string().trim().min(1) });

/** Modelo padrão do agy, já como id ("Gemini 3.8 Flash (Medium)" -> gemini-3.8-flash-medium). */
export function readAgySettingsModel(file = DEFAULT_AGY_SETTINGS_FILE): string | null {
  try {
    const parsed = agySettings.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? agyModelId(parsed.data.model) : null;
  } catch {
    return null;
  }
}

const tomlValue = (raw: string): string | null => {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(raw);
  return match ? (match[1] ?? match[2] ?? null) : null;
};

/** Modelo padrão do Codex no config.toml: `model` no topo ou no perfil ativo (`profile` ou --profile). */
export function readCodexConfigModel(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), profile: string | null = null): string | null {
  let text: string;
  try { text = readFileSync(join(codexHome, 'config.toml'), 'utf8'); } catch { return null; }
  const values = new Map<string, string>();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) { section = header[1]!.trim().replace(/["']/g, ''); continue; }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=(.*)$/.exec(line);
    if (!pair) continue;
    const value = tomlValue(pair[2]!);
    if (value !== null) values.set(section ? `${section}.${pair[1]}` : pair[1]!, value);
  }
  const active = profile ?? values.get('profile') ?? null;
  return (active ? values.get(`profiles.${active}.model`) : undefined) ?? values.get('model') ?? null;
}

/** Último valor de uma flag nos argumentos extras (`--flag valor` ou `--flag=valor`): o último vence no CLI. */
function lastFlag(args: string[], flags: string[]): string | null {
  let found: string | null = null;
  args.forEach((arg, index) => {
    const [flag, inline] = arg.includes('=') && arg.startsWith('-') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!flags.includes(flag!)) return;
    const value = inline ?? args[index + 1];
    if (value && !value.startsWith('-')) found = value;
  });
  return found;
}

/** Modelo e perfil que os argumentos extras do terminal impõem ao CLI (`-m`, `--model`, `-c model=...`). */
export function modelFromArgs(agent: ModelAgent, args: string[]): { model: string | null; profile: string | null } {
  let model = lastFlag(args, agent === 'codex' ? ['-m', '--model'] : ['--model']);
  if (agent === 'codex') {
    args.forEach((arg, index) => {
      if ((arg === '-c' || arg === '--config') && args[index + 1]?.startsWith('model=')) model = tomlValue(args[index + 1]!.slice(6)) ?? args[index + 1]!.slice(6);
    });
  }
  return { model, profile: agent === 'codex' ? lastFlag(args, ['-p', '--profile']) : null };
}

/**
 * Modelo com que o CLI começa, antes do primeiro turno: os argumentos extras vêm depois da flag da tag e vencem;
 * sem flag, vale o padrão do CLI (config.toml do Codex, settings.json do agy). O Claude informa no SessionStart.
 */
export function startupModel(agent: ModelAgent, input: { chosen: string | null; args: string[]; codexHome?: string; agySettingsFile?: string }): string | null {
  if (agent === 'claude') return null;
  const fromArgs = modelFromArgs(agent, input.args);
  const flagged = fromArgs.model ?? input.chosen;
  if (flagged) return agent === 'agy' ? agyModelId(flagged) : flagged;
  return agent === 'codex' ? readCodexConfigModel(input.codexHome, fromArgs.profile) : readAgySettingsModel(input.agySettingsFile);
}
