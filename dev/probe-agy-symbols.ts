// Sondagem: os eventos de tecla win32-input fazem os símbolos chegarem ao campo de entrada do agy?
// Não envia Enter: só digita e lê a tela. Uso: npx tsx dev/probe-agy-symbols.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUnsafeForAgy } from '../packages/core/src/adapters/agy.js';
import { childEnv } from '../packages/core/src/env.js';
import { encodeWithWin32 } from '../packages/core/src/input.js';
import { nodePtyHost } from '../packages/core/src/pty-host.js';
import { resolveExecutable } from '../packages/core/src/resolve-exe.js';
import { Screen } from '../packages/core/src/screen.js';

const SAMPLE = '[1×2 ÷ ± ✅ 🚀 “aspas” – —]';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = mkdtempSync(join(tmpdir(), 'orq-sym-'));
const agy = resolveExecutable('agy');
const screen = new Screen(120, 40);
const pty = nodePtyHost.spawn({ file: agy.file, args: agy.argsPrefix, cwd, env: childEnv(process.env) });
pty.onData((data) => void screen.write(data));

await sleep(8000);
if (/Do you trust the contents of this project\?/.test(screen.visible())) {
  pty.write('\r');
  await sleep(6000);
}
pty.write(encodeWithWin32(SAMPLE, isUnsafeForAgy));
await sleep(2000);
const line = screen.visible().split('\n').find((text) => text.includes('[1'));
console.log(`enviado: ${SAMPLE}`);
console.log(`na tela: ${line ?? '(não encontrado)'}`);
console.log(line?.includes(SAMPLE) ? 'RESULTADO: keys funciona' : 'RESULTADO: keys NÃO funciona');
await pty.kill();
process.exit(0);
