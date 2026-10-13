// Sondagem do harness: roda o harness num ConPTY, anexa a um shell e confere se o texto digitado chega uma vez só.
// Uso: npx tsx dev/probe-harness-attach.ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../packages/core/src/env.js';
import { nodePtyHost } from '../packages/core/src/pty-host.js';
import { resolveExecutable } from '../packages/core/src/resolve-exe.js';
import { Screen } from '../packages/core/src/screen.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = mkdtempSync(join(tmpdir(), 'orq-hp-'));
const npx = resolveExecutable('npx');
const screen = new Screen(120, 40);
const harness = nodePtyHost.spawn({
  file: npx.file,
  args: [...npx.argsPrefix, 'tsx', 'dev/harness.ts'],
  cwd: process.cwd(),
  env: { ...childEnv(process.env), ORQ_HARNESS_PIPE: `\\\\.\\pipe\\orq-hp-${process.pid}` },
});
harness.onData((data) => void screen.write(data));
const type = async (text: string) => {
  for (const char of text) {
    harness.write(char);
    await sleep(40);
  }
};

await sleep(8000);
await type(`new S shell ${cwd}\r`);
await sleep(5000);
await type('attach S\r');
await sleep(2000);
await type('Set-Content marcador.txt ok-unico\r');
await sleep(2500);
console.log(`--- tela ---\n${screen.visible().split('\n').slice(-10).join('\n')}`);
// Efeito real do comando: o arquivo só existe com esse conteúdo se o PowerShell recebeu cada tecla uma vez.
const file = join(cwd, 'marcador.txt');
const content = existsSync(file) ? readFileSync(file, 'utf8').trim() : '(arquivo não criado)';
console.log(content === 'ok-unico' ? 'RESULTADO: teclas ok' : `RESULTADO: teclas perdidas ou duplicadas (${content})`);
// Desenho: o comando aparece uma vez (eco do shell), sem eco do readline e sem letras dobradas.
// Anexado, a janela mostra só o terminal interno: nada do prompt do harness por baixo nem eco do readline.
const visible = screen.visible();
const echoes = (visible.match(/Set-Content marcador\.txt ok-unico/g) ?? []).length;
const leftovers = visible.includes('orquestra>');
console.log(echoes === 1 && !leftovers ? 'RESULTADO: desenho ok' : `RESULTADO: desenho errado (ecos ${echoes}, restos do harness ${leftovers})`);
harness.write('\x11');
await sleep(500);
await type('quit\r');
await sleep(4000);
await harness.kill();
process.exit(0);
