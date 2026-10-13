// Sondagem: que texto o Claude Code mostra quando o turno é interrompido com Esc?
// Uso: npx tsx dev/probe-claude-interrupt.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../packages/core/src/adapters/claude.js';
import { childEnv } from '../packages/core/src/env.js';
import { writePrompt } from '../packages/core/src/input.js';
import { nodePtyHost } from '../packages/core/src/pty-host.js';
import { resolveExecutable } from '../packages/core/src/resolve-exe.js';
import { Screen } from '../packages/core/src/screen.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = mkdtempSync(join(tmpdir(), 'orq-int-'));
const claude = resolveExecutable('claude');
const screen = new Screen(120, 40);
const pty = nodePtyHost.spawn({ file: claude.file, args: claude.argsPrefix, cwd, env: childEnv(process.env) });
pty.onData((data) => void screen.write(data));

await sleep(8000);
if (/Yes, I trust this folder/.test(screen.visible())) {
  pty.write('\x1b[B');
  await sleep(400);
  pty.write('\r');
  await sleep(6000);
}
console.log(`--- tela antes do prompt ---\n${screen.visible().split('\n').slice(-6).join('\n')}`);
await writePrompt(pty, 'Escreva um texto longo, de uns 40 parágrafos, sobre a história dos terminais.');
// Uso: npx tsx dev/probe-claude-interrupt.ts [ms até o Esc]; 4000 pega o raciocínio, ~20000 pega a resposta sendo escrita.
const escAfterMs = Number(process.argv[2] ?? 4000);
await sleep(escAfterMs);
console.log(`--- tela ${escAfterMs} ms depois do prompt ---\n${screen.visible().split('\n').slice(-8).join('\n')}`);
pty.write('\x1b');
await sleep(3000);
const visible = screen.visible();
console.log('--- tela depois do Esc ---');
console.log(visible.split('\n').slice(-12).join('\n'));
console.log(`--- linhas com "Interrupt" ---\n${visible.split('\n').filter((line) => /interrupt/i.test(line)).join('\n')}`);
const rule = claudeAdapter.screenRules.find((candidate) => candidate.signal === 'interrupted');
console.log(rule?.pattern.test(visible) ? 'RESULTADO: padrão atual reconhece' : 'RESULTADO: padrão atual NÃO reconhece');
await pty.kill();
process.exit(0);
