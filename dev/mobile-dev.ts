import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PID_FILE,
  REMOTE_DEV_PORT,
  REMOTE_TAILSCALE_DEV_HTTPS_PORT,
  type HostToMain,
  type ProjectSnapshot,
} from '@orquestra/shared';
import { buildCli } from '../packages/cli/build.js';
import { createLogger, installCli, shellAdapter, type AgentAdapter } from '../packages/core/src/index.js';
import { createFakeAdapter } from '../packages/core/test/helpers/fake-adapter.js';
import type { HostBridge } from '../packages/host/src/bridge.js';
import { RemoteGateway, TailscaleServeManager } from '../packages/host/src/remote/index.js';
import { startWorkspaceManager } from '../packages/host/src/workspace-manager.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mobileDir = join(repoRoot, 'packages', 'mobile', 'dist');

export type MobileDevDeps = {
  argv?: string[];
  buildCli?: typeof buildCli;
  buildMobile?: () => void;
  installCli?: typeof installCli;
  createGateway?: (opts: ConstructorParameters<typeof RemoteGateway>[0]) => Pick<
    RemoteGateway,
    'enable' | 'wrapBridge' | 'onHostMessage' | 'pair' | 'status' | 'close'
  >;
  startWorkspaceManager?: typeof startWorkspaceManager;
  sleep?: (ms: number) => Promise<void>;
  signalTarget?: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
  stdin?: {
    isTTY?: boolean;
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
    off?(event: 'data', listener: (chunk: unknown) => void): unknown;
  };
  exit?: (code: number) => void;
};

function defaultBuildMobile(): void {
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

export async function runMobileDev(deps: MobileDevDeps = {}): Promise<void> {
  const argv = deps.argv ?? process.argv;
  const runBuildCli = deps.buildCli ?? buildCli;
  const runBuildMobile = deps.buildMobile ?? defaultBuildMobile;
  const runInstallCli = deps.installCli ?? installCli;
  const createGateway = deps.createGateway ?? ((opts) => new RemoteGateway(opts));
  const runStartWorkspaceManager = deps.startWorkspaceManager ?? startWorkspaceManager;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signalTarget = deps.signalTarget ?? process;
  const stdin = deps.stdin ?? process.stdin;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  console.log('Construindo CLI e interface móvel (@orquestra/mobile)...');
  const cliBuilt = await runBuildCli();
  runBuildMobile();

  const dataDir = mkdtempSync(join(tmpdir(), 'orq-mobile-dev-'));
  const binDir = join(dataDir, 'bin');
  const projectAlpha = join(dataDir, 'projeto-alpha');
  const projectBeta = join(dataDir, 'projeto-beta');
  mkdirSync(projectAlpha, { recursive: true });
  mkdirSync(projectBeta, { recursive: true });

  const { log, close: closeLog } = createLogger({ dir: join(dataDir, 'logs'), name: 'orquestra-mobile-dev' });
  const installed = runInstallCli({ script: cliBuilt, binDir });
  const pipePath = `\\\\.\\pipe\\orq-mobile-dev-${process.pid}`;
  const port = Number(process.env.ORQ_REMOTE_PORT) || REMOTE_DEV_PORT;
  const useTailscale = argv.includes('--tailscale');

  const gateway = createGateway({
    dataDir,
    log: log.child({ component: 'remote' }),
    electronSend: (_message: HostToMain) => {},
    port,
    mobileDir,
    persistEnabledState: false,
    tailscale: useTailscale
      ? new TailscaleServeManager({
          httpsPort: REMOTE_TAILSCALE_DEV_HTTPS_PORT,
          log: log.child({ component: 'tailscale' }),
        })
      : false,
  });

  let bridge: HostBridge | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const signalListeners: Array<[string, () => void]> = [];
  const onStdinData = (chunk: unknown) => {
    if (String(chunk).trim() === 'shutdown') void shutdown(0);
  };

  const shutdown = (exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      for (const [sig, fn] of signalListeners) {
        signalTarget.off(sig, fn);
      }
      stdin.off?.('data', onStdinData);
      try {
        if (bridge) await bridge.close();
        else await gateway.close();
      } catch (err) {
        console.error('Erro ao encerrar gateway/bridge:', err);
      }
      try {
        await closeLog();
      } catch {}
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
      exit(exitCode);
    })();
    return shutdownPromise;
  };

  // Registra os sinais antes de gateway.enable(true) para nunca deixar regra 8444 ou processos órfãos.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    const fn = () => void shutdown(0);
    signalListeners.push([sig, fn]);
    signalTarget.on(sig, fn);
  }
  if (!stdin.isTTY) {
    stdin.on('data', onStdinData);
  }

  try {
    const inner = await runStartWorkspaceManager({
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

    bridge = gateway.wrapBridge(inner);
    await gateway.enable(true);
    if (shutdownPromise) return;

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
        void bridge!.handle({ kind: 'command', id, method, params, workspaceId }).catch((err) => {
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
    await sleep(2000);
    if (shutdownPromise) return;
    await exec('terminal.input', { name: 'z-claude', data: 'AGUARDANDO\r' }, alpha.workspaceId);
    await sleep(500);
    if (shutdownPromise) return;

    const pair = gateway.pair();
    const status = gateway.status();
    console.log('\n==================================================');
    console.log('Orquestra Mobile Dev pronto!');
    console.log(`Gateway local: ${status.localUrl}`);
    if (useTailscale) {
      if (status.tailscale?.url) {
        console.log(`Tailscale HTTPS: ${status.tailscale.url}`);
      } else if (status.tailscale?.error) {
        console.log(`Tailscale erro: ${status.tailscale.error}`);
      }
    }
    console.log(`Link de pareamento (uso único, 5 min): ${pair.url}`);
    console.log(`DataDir isolado: ${dataDir}`);
    console.log('==================================================\n');
  } catch (err) {
    console.error('Erro ao inicializar mobile:dev:', err);
    await shutdown(1);
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]!).toLowerCase();

if (isDirectExecution) {
  void runMobileDev().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
