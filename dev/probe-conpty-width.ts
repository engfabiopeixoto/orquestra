// Sondagem: o ConPTY do sistema (Windows 10) e o ConPTY do node-pty posicionam o texto digitado no Claude
// do mesmo jeito? Uso: npx tsx dev/probe-conpty-width.ts <pasta confiável pelo Claude>
import * as pty from 'node-pty';
import { childEnv } from '../packages/core/src/env.js';
import { resolveExecutable } from '../packages/core/src/resolve-exe.js';
import { Screen } from '../packages/core/src/screen.js';

const cwd = process.argv[2] ?? process.cwd();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(useConptyDll: boolean): Promise<string> {
  const exe = resolveExecutable('claude');
  const screen = new Screen(100, 30);
  const proc = pty.spawn(exe.file, exe.argsPrefix, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: childEnv(process.env), useConpty: true, useConptyDll });
  proc.onData((data) => void screen.write(data));
  await sleep(8000);
  for (const letter of 'asdasd') {
    proc.write(letter);
    await sleep(120);
  }
  await sleep(1500);
  const line = screen.text().split('\n').find((text) => text.includes('sd')) ?? '(linha não encontrada)';
  proc.kill();
  await sleep(500);
  return line;
}

console.log('ConPTY do sistema :', JSON.stringify(await probe(false)));
console.log('ConPTY do node-pty:', JSON.stringify(await probe(true)));
process.exit(0);
