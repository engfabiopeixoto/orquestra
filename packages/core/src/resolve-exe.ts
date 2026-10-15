import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { OrqError } from '@orquestra/shared';

export type ResolvedExecutable = { file: string; argsPrefix: string[] };

export function resolveExecutable(name: string, deps: {
  where?: (name: string) => string[];
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
} = {}): ResolvedExecutable {
  const env = deps.env ?? process.env;
  let candidates: string[];
  try {
    candidates = deps.where ? deps.where(name) : execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    candidates = [];
  }
  // Explorer may inherit a PATH without the shell's mise initialization.
  // Search only known installation directories, without invoking a login shell.
  if (!candidates.some((path) => /\.(exe|cmd|bat)$/i.test(path)) && (name === 'codex' || name === 'agy')) {
    const home = env.USERPROFILE ?? homedir();
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const dirs = [dirname(deps.nodePath ?? process.execPath), join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')];
    const miseNode = join(env.MISE_DATA_DIR ?? join(local, 'mise'), 'installs', 'node');
    try {
      dirs.push(...readdirSync(miseNode, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => join(miseNode, version)));
    } catch { /* mise is optional */ }
    if (name === 'agy') dirs.unshift(join(local, 'agy', 'bin'));
    candidates = dirs.flatMap((dir) => [`${name}.exe`, `${name}.cmd`, `${name}.bat`].map((file) => join(dir, file))).filter(existsSync);
  }
  const exe = candidates.find((path) => path.toLowerCase().endsWith('.exe'));
  if (exe) return { file: exe, argsPrefix: [] };
  const script = candidates.find((path) => /\.(cmd|bat)$/i.test(path));
  if (script) {
    // Run npm's Codex launcher directly: cmd.exe interprets <, >, &, and quotes
    // inside developer instructions, corrupting config and prompt arguments.
    if (name === 'codex') {
      const launcher = join(dirname(script), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(launcher)) return { file: deps.nodePath ?? process.execPath, argsPrefix: [launcher] };
    }
    const comspec = env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    return { file: comspec, argsPrefix: ['/d', '/c', script] };
  }
  throw new OrqError('APP_UNAVAILABLE', `${name} não encontrado no PATH nem nas pastas de instalação. Instale o programa ou ajuste o PATH.`);
}
