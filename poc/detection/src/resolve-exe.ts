import { execFileSync } from 'node:child_process';

export type ResolvedExecutable = { file: string; argsPrefix: string[] };

export function resolveExecutable(name: string): ResolvedExecutable {
  let candidates: string[];
  try {
    candidates = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    throw new Error(`${name} não encontrado no PATH. Instale o programa ou ajuste o PATH.`);
  }
  const exe = candidates.find((path) => path.toLowerCase().endsWith('.exe'));
  if (exe) return { file: exe, argsPrefix: [] };
  const cmd = candidates.find((path) => /\.(cmd|bat)$/i.test(path));
  if (cmd) {
    const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    return { file: comspec, argsPrefix: ['/d', '/c', cmd] };
  }
  throw new Error(`${name} não encontrado no PATH. Instale o programa ou ajuste o PATH.`);
}
