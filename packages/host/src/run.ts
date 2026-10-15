import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PID_FILE, defaultPipePath, HOST_EXIT_PIPE_BUSY, mainToHostSchema, type HostToMain } from '@orquestra/shared';
import { createLogger, DEFAULT_BIN_DIR, installCli, type AgentAdapter } from '@orquestra/core';
import { type HostBridge } from './bridge.js';
import { startWorkspaceManager } from './workspace-manager.js';

export async function runHost(opts: { adapters: Record<string, AgentAdapter> }): Promise<void> {
  const cliScript = process.env.ORQ_CLI_SCRIPT;
  if (!cliScript) {
    console.error('ORQ_CLI_SCRIPT ausente. O processo do núcleo precisa ser iniciado pelo app.');
    process.exit(1);
  }
  // Depois de o principal desconectar, enviar lançaria ERR_IPC_CHANNEL_CLOSED e derrubaria o encerramento
  // no meio (agentes órfãos). O callback vazio evita o erro assíncrono de um envio que falhe em trânsito.
  const send = (message: HostToMain) => {
    if (process.connected) process.send?.(message, undefined, undefined, () => {});
  };
  const dataDir = process.env.ORQ_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Orquestra');
  const { log, close: closeLog } = createLogger({ dir: join(dataDir, 'logs'), name: 'orquestra' });
  const hostLog = log.child({ component: 'host' });
  const installed = installCli({ script: cliScript, binDir: process.env.ORQ_BIN_DIR ?? DEFAULT_BIN_DIR });
  let bridge: HostBridge;
  try {
    bridge = await startWorkspaceManager({
      send,
      adapters: opts.adapters,
      cliScript: installed.script,
      pipePath: process.env.ORQ_PIPE_PATH ?? defaultPipePath(),
      dataDir,
      log: hostLog,
      agentPidFile: join(dataDir, AGENT_PID_FILE),
      recentFile: join(dataDir, 'recent.json'),
      settingsFile: join(dataDir, 'settings.json'),
      personasFile: join(dataDir, 'personas.json'),
      agyHooksFile: process.env.ORQ_AGY_HOOKS_FILE,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      hostLog.error({ err: error }, 'pipe do Orquestra já está em uso');
      await closeLog();
      process.exit(HOST_EXIT_PIPE_BUSY);
    }
    throw error;
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    hostLog.info('encerrando o núcleo');
    await bridge.close();
    await closeLog();
    process.exit(0);
  };

  process.on('message', (raw) => {
    const parsed = mainToHostSchema.safeParse(raw);
    if (!parsed.success) return hostLog.warn({ raw }, 'mensagem inválida do principal');
    if (parsed.data.kind === 'shutdown') return void shutdown();
    void bridge.handle(parsed.data);
  });
  // O principal morreu sem pedir encerramento: não deixar agentes órfãos.
  process.on('disconnect', () => void shutdown());
  hostLog.info({ cli: installed.script }, 'núcleo pronto');
  send({ kind: 'ready' });
}
