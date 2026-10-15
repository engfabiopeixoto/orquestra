import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OrqError } from '@orquestra/shared';

export const DEFAULT_BIN_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Orquestra', 'bin');

// O agy divide o comando do hook nos espaços e ignora aspas: o caminho do orq não pode ter espaço.
export function spaceFreePath(dir: string): string {
  if (!/\s/.test(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  const short = execSync(`for %I in ("${dir}") do @echo %~sI`, { shell: process.env.ComSpec ?? 'cmd.exe', encoding: 'utf8', windowsHide: true }).trim();
  if (!short || /\s/.test(short)) {
    throw new OrqError('INTERNAL', `Não há caminho sem espaço para ${dir}. Ative os nomes curtos 8.3 no disco ou escolha outra pasta.`);
  }
  return short;
}

export function installCli(opts: { script: string; binDir: string }): { binDir: string; script: string } {
  mkdirSync(opts.binDir, { recursive: true });
  copyFileSync(opts.script, join(opts.binDir, 'orq.mjs'));
  writeFileSync(join(opts.binDir, 'orq.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0orq.mjs" %*\r\n`);
  writeFileSync(join(opts.binDir, 'orq'), '#!/bin/sh\nexec node "$(dirname "$0")/orq.mjs" "$@"\n');
  const binDir = spaceFreePath(opts.binDir);
  return { binDir, script: `${binDir.replaceAll('\\', '/')}/orq.mjs` };
}
