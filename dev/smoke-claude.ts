// Teste com agentes reais, sem teclado: dois Claude Code conectados; A usa o orq para perguntar a B e criar uma nota.
// Não altera configurações do usuário (os hooks do Claude são por sessão). Uso: npx tsx dev/smoke-claude.ts
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCli } from '../packages/cli/build.js';
import { claudeAdapter, createLogger, createOrquestra, installCli, type Session } from '../packages/core/src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const root = join(tmpdir(), 'orq-smoke');
const logDir = join(root, 'logs');
const { log, close: closeLog } = createLogger({ dir: logDir, name: 'orquestra', level: 'debug' });
const { script } = installCli({ script: await buildCli(), binDir: join(root, 'bin') });
const orquestra = await createOrquestra({
  pipePath: `\\\\.\\pipe\\orq-smoke-${process.pid}`,
  dataDir: join(root, 'data'),
  cliScript: script,
  adapters: { claude: claudeAdapter },
  log,
});

async function waitState(session: Session, accept: (state: Session['state']) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!accept(session.state)) {
    if (Date.now() > deadline) throw new Error(`${session.name} ficou em ${session.state} além do prazo.`);
    await sleep(250);
  }
}

// O diálogo de confiança aparece como "waiting"; respondemos como o usuário faria (seta para baixo e Enter).
async function startTrusted(name: string): Promise<Session> {
  const cwd = join(root, `cwd-${name}`);
  mkdirSync(cwd, { recursive: true });
  const session = orquestra.createTerminal({ name, agent: 'claude', cwd });
  await waitState(session, (state) => state === 'idle' || state === 'waiting', 30_000);
  if (session.state === 'waiting' && /Yes, I trust this folder/.test(session.screenText())) {
    await sleep(1500);
    session.userInput('\x1b[B');
    await sleep(400);
    session.userInput('\r');
  }
  await waitState(session, (state) => state === 'idle', 30_000);
  return session;
}

async function ask(session: Session, text: string): Promise<void> {
  for (const char of text) session.userInput(char);
  await sleep(300);
  session.userInput('\r');
  await waitState(session, (state) => state === 'busy', 10_000);
  await waitState(session, (state) => state === 'idle', 240_000);
}

try {
  const a = await startTrusted('A');
  const b = await startTrusted('B');
  orquestra.connect('A', 'B');
  console.log('A e B prontos e conectados.');

  await ask(a, 'Rode no terminal: orq prompt B "Quanto é 2+2? Responda só o número." e depois me responda só com o que ele imprimir.');
  console.log(`--- tela de A ---\n${a.screenText(25)}`);
  console.log(`--- tela de B ---\n${b.screenText(15)}`);

  await ask(a, 'Rode no terminal: orq note write plano "# Plano do smoke" e depois orq note show plano. Responda só com o conteúdo mostrado.');
  console.log(`--- tela de A ---\n${a.screenText(20)}`);
  console.log(`--- nota ---\n${JSON.stringify(orquestra.notes.get('plano'))}`);
} catch (error) {
  console.log(`FALHOU: ${(error as Error).message}`);
  for (const session of orquestra.sessions()) console.log(`--- ${session.name} (${session.state}) ---\n${session.screenText(20)}`);
} finally {
  await orquestra.close();
  await closeLog();
  console.log(`Logs em ${logDir}`);
  process.exit(0);
}
