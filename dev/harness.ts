// Harness da fase 1: cria terminais reais, conecta e anexa o teclado, sem interface gráfica.
// Uso: npm run harness
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { defaultPipePath } from '@orquestra/shared';
import { buildCli } from '../packages/cli/build.js';
import {
  agyAdapter,
  agyStopHookCommand,
  claudeAdapter,
  createLogger,
  createOrquestra,
  DEFAULT_BIN_DIR,
  ensureAgyGlobalHook,
  installCli,
  shellAdapter,
} from '../packages/core/src/index.js';
import { DETACH_HINT, isDetachKey } from './harness-keys.js';

const dataDir = join(process.env.APPDATA ?? '.', 'Orquestra');
const { log, close: closeLog } = createLogger({ dir: join(dataDir, 'logs'), name: 'orquestra' });
const { script } = installCli({ script: await buildCli(), binDir: DEFAULT_BIN_DIR });
const orquestra = await createOrquestra({
  // ORQ_HARNESS_PIPE: permite rodar um segundo harness (testes) sem disputar o pipe padrão.
  pipePath: process.env.ORQ_HARNESS_PIPE ?? defaultPipePath(),
  dataDir,
  cliScript: script,
  adapters: { claude: claudeAdapter, agy: agyAdapter, shell: shellAdapter },
  log,
});
const newPrompt = () => createInterface({ input: process.stdin, output: process.stdout });
let rl = newPrompt();

console.log(`Orquestra (harness). Pipe: ${orquestra.pipePath}. orq em ${script}.`);
console.log(`Comandos: new <nome> <claude|agy|shell> <pasta> · connect <a> <b> · state · attach <nome> (${DETACH_HINT} solta) · quit`);

async function attach(name: string): Promise<void> {
  const session = orquestra.session(name);
  if (!session) return void console.log(`Terminal ${name} não existe.`);
  // Pausar não basta: o readline continua lendo o teclado, ecoa as teclas e disputa a entrada com o terminal.
  rl.close();
  // O terminal interno desenha com posições absolutas: limpamos a janela e ajustamos o tamanho dele ao dela.
  // O resize em dois passos força o ConPTY a redesenhar tudo, mesmo se o tamanho já for igual.
  process.stdout.write('\x1b[2J\x1b[H');
  const stopOutput = session.onOutput((data) => process.stdout.write(data));
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  session.resize(cols - 1, rows);
  await new Promise((resolve) => setTimeout(resolve, 100));
  session.resize(cols, rows);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    const onKey = (key: Buffer) => {
      const text = key.toString('utf8');
      if (isDetachKey(text)) {
        process.stdin.off('data', onKey);
        process.stdin.setRawMode(false);
        resolve();
        return;
      }
      session.userInput(text);
    };
    process.stdin.on('data', onKey);
  });
  stopOutput();
  process.stdout.write('\x1b[2J\x1b[H');
  rl = newPrompt();
  console.log(`(solto de ${name}; ${DETACH_HINT} só funciona dentro do attach)`);
}

for (;;) {
  const [command, ...args] = (await rl.question('orquestra> ')).trim().split(/\s+/);
  try {
    if (command === 'quit') break;
    if (command === 'new') {
      const [name, agent, cwd] = args;
      if (!name || !agent || !cwd) throw new Error('Uso: new <nome> <claude|agy|shell> <pasta>');
      if (agent === 'agy') {
        const result = await ensureAgyGlobalHook({
          command: agyStopHookCommand(script),
          confirm: async (message) => (await rl.question(`${message} (s/n) `)).trim().toLowerCase() === 's',
        });
        if (result === 'declined') throw new Error('Sem o hook, o Orquestra não sabe quando o agy termina. Terminal não criado.');
      }
      orquestra.createTerminal({ name, agent, cwd });
      console.log(`${name} criado. Se aparecer um diálogo de confiança, use attach ${name} para responder.`);
    } else if (command === 'connect') {
      const [a, b] = args;
      if (!a || !b) throw new Error('Uso: connect <a> <b>');
      orquestra.connect(a, b);
    } else if (command === 'state') {
      for (const session of orquestra.sessions()) {
        console.log(`${session.name}\t${session.adapter.kind}\t${session.state}\tfila ${orquestra.broker.queued(session.name)}`);
      }
    } else if (command === 'attach') {
      await attach(args[0] ?? '');
    } else if (command) {
      console.log('Comando desconhecido.');
    }
  } catch (error) {
    console.log((error as Error).message);
  }
}

rl.close();
await orquestra.close();
await closeLog();
process.exit(0);
