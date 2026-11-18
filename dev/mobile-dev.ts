import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PID_FILE, REMOTE_DEV_PORT, type HostToMain, type ProjectSnapshot } from '@orquestra/shared';
import { buildCli } from '../packages/cli/build.js';
import { createLogger, installCli, shellAdapter, type AgentAdapter } from '../packages/core/src/index.js';
import { createFakeAdapter } from '../packages/core/test/helpers/fake-adapter.js';
import { RemoteGateway } from '../packages/host/src/remote/index.js';
import { startWorkspaceManager } from '../packages/host/src/workspace-manager.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mobileDir = join(repoRoot, 'packages', 'mobile', 'dist');

function buildMobile(): void {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['run', 'build', '-w', '@orquestra/mobile'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
}

function fakeAgentAdapter(kind: 'claude' | 'agy' | 'codex'): AgentAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    kind,
    interpretHook: (event, payload) => {
      const signal = base.interpretHook(event, payload);
      if (signal.kind === 'turn-end' && signal.text?.includes('AGUARDANDO')) {
        return { kind: 'waiting', detail: 'Aguardando aprovação' };
      }
      return signal;
    },
    screenRules: [
      { pattern: /AGUARDANDO|Do you want to proceed|Approve this/, signal: 'waiting', scope: 'visible' },
      { pattern: /Interrupted/, signal: 'interrupted', scope: 'new-occurrence' },
    ],
  };
}

async function main(): Promise<void> {
  console.log('Construindo CLI e interface móvel (@orquestra/mobile)...');
  const cliBuilt = await buildCli();
  buildMobile();

  const dataDir = mkdtempSync(join(tmpdir(), 'orq-mobile-dev-'));
  const binDir = join(dataDir, 'bin');
  const projectAlpha = join(dataDir, 'projeto-alpha');
  const projectBeta = join(dataDir, 'projeto-beta');
  mkdirSync(projectAlpha, { recursive: true });
  mkdirSync(projectBeta, { recursive: true });

  const { log, close: closeLog } = createLogger({ dir: join(dataDir, 'logs'), name: 'orquestra-mobile-dev' });
  const installed = installCli({ script: cliBuilt, binDir });
  const pipePath = `\\\\.\\pipe\\orq-mobile-dev-${process.pid}`;
  const port = Number(process.env.ORQ_REMOTE_PORT) || REMOTE_DEV_PORT;

  const gateway = new RemoteGateway({
    dataDir,
    log: log.child({ component: 'remote' }),
    electronSend: (_message: HostToMain) => {},
    port,
    mobileDir,
    persistEnabledState: false,
  });

  const inner = await startWorkspaceManager({
    send: (message) => gateway.onHostMessage(message),
    adapters: {
      shell: shellAdapter,
      claude: fakeAgentAdapter('claude'),
      agy: fakeAgentAdapter('agy'),
      codex: fakeAgentAdapter('codex'),
    },
    cliScript: installed.script,
    pipePath,
    dataDir,
    log,
    agentPidFile: join(dataDir, AGENT_PID_FILE),
    recentFile: join(dataDir, 'recent.json'),
    settingsFile: join(dataDir, 'settings.json'),
    personasFile: join(dataDir, 'personas.json'),
    agyHooksFile: join(dataDir, 'agy-hooks.json'),
    modelCatalogDeps: {
      probeVersion: async () => null,
      probeClaudeCatalogMtime: () => null,
      discover: async (agent) => {
        throw new Error(`${agent} desativado no mobile:dev`);
      },
    },
  });

  const bridge = gateway.wrapBridge(inner);
  await gateway.enable(true);

  const pendingResponses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const origSend = gateway.onHostMessage.bind(gateway);
  gateway.onHostMessage = (message) => {
    if (message.kind === 'response' || message.kind === 'response-error') {
      const waiter = pendingResponses.get(message.id);
      if (waiter) {
        pendingResponses.delete(message.id);
        if (message.kind === 'response') waiter.resolve(message.result);
        else waiter.reject(new Error(message.error.message));
        return;
      }
    }
    origSend(message);
  };

  let cmdSeq = 1;
  async function exec(method: string, params: unknown, workspaceId?: string): Promise<unknown> {
    const id = `dev-${cmdSeq++}`;
    return new Promise((resolve, reject) => {
      pendingResponses.set(id, { resolve, reject });
      void bridge.handle({ kind: 'command', id, method, params, workspaceId }).catch((err) => {
        if (pendingResponses.delete(id)) reject(err);
      });
    });
  }

  // Semeia dois workspaces de exemplo sem tocar no ambiente real do usuário.
  const beta = (await exec('project.open', { dir: projectBeta })) as ProjectSnapshot;
  await exec('terminal.create', { name: 'shell-beta', agent: 'shell', resume: false }, beta.workspaceId);

  const alpha = (await exec('project.open', { dir: projectAlpha })) as ProjectSnapshot;
  await exec('terminal.create', { name: 'a-shell', agent: 'shell', resume: false }, alpha.workspaceId);
  await exec('terminal.create', { name: 'b-codex', agent: 'codex', resume: false }, alpha.workspaceId);
  await exec('terminal.create', { name: 'z-claude', agent: 'claude', regente: true, resume: false }, alpha.workspaceId);

  // Espera o terminal ficar ocioso (readyQuietMs ~1500 ms) e coloca z-claude em 'waiting'
  // para demonstrar a ordenação "Esperando você" sempre no topo da lista.
  await new Promise((r) => setTimeout(r, 2000));
  await exec('terminal.input', { name: 'z-claude', data: 'AGUARDANDO\r' }, alpha.workspaceId);
  await new Promise((r) => setTimeout(r, 500));

  const pair = gateway.pair();
  const status = gateway.status();
  console.log('\n==================================================');
  console.log('Orquestra Mobile Dev pronto!');
  console.log(`Gateway: ${status.localUrl}`);
  console.log(`Link de pareamento (uso único, 5 min): ${pair.url}`);
  console.log(`DataDir isolado: ${dataDir}`);
  console.log('==================================================\n');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge.close();
    await closeLog();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
