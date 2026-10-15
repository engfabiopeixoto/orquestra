import { join } from 'node:path';
import { release as osRelease } from 'node:os';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { AGENT_PID_FILE, isHostMethod, OrqError } from '@orquestra/shared';
import type { AppInfo, CommandResponse } from '../shared/bridge';
import { ActivityMonitor } from './activity';
import { appShortcut, handleAppAction } from './app-action';
import { appUserModelId } from './app-id';
import { bundledScripts } from './bundled-paths';
import { HostProcess } from './host-process';
import { createAppLogger } from './log';
import { resolveNodePath, whereNode } from './node-path';
import { killRecordedAgents, taskkillTree } from './orphans';
import { initPortalSystem } from './portal/portal-ipc';
import type { PortalManager } from './portal/portal-manager';

const dataDir = process.env.ORQ_DATA_DIR ?? join(app.getPath('appData'), 'Orquestra');
// Pasta de dados própria (testes, segunda cópia de desenvolvimento): a trava de instância única vale por pasta.
if (process.env.ORQ_DATA_DIR) app.setPath('userData', join(dataDir, 'electron'));
const { log, logDir } = createAppLogger(dataDir);
const scripts = bundledScripts({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname });
const hostScript = process.env.ORQ_HOST_SCRIPT ?? scripts.host;
const cliScript = process.env.ORQ_CLI_SCRIPT ?? scripts.cli;

let window: BrowserWindow | null = null;
let host: HostProcess | null = null;
let portalSystem: { portalManager: PortalManager; dispose: () => void } | null = null;
let quitting = false;

const activityMonitor = new ActivityMonitor({
  isFocused: () => window?.isFocused() ?? false,
  notify: ({ name, title, body, workspaceId }) => {
    const notification = new Notification({ title, body });
    log.info({ terminal: name, title }, 'notificação mostrada');
    notification.on('click', () => {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send('orq:focus-terminal', name, workspaceId);
    });
    notification.show();
  },
});

async function startHost(): Promise<HostProcess> {
  const nodePath = resolveNodePath({ env: process.env, where: whereNode });
  const process_ = new HostProcess({
    nodePath,
    script: hostScript,
    env: { ...process.env, ORQ_CLI_SCRIPT: cliScript, ORQ_DATA_DIR: dataDir },
    onLog: (line) => log.warn({ component: 'host-stderr' }, line),
  });
  process_.setBrowserHandler(async (workspaceId, method, params, signal) => {
    if (!portalSystem) throw new OrqError('APP_UNAVAILABLE', 'Navegador indisponível.');
    return portalSystem.portalManager.agentCommand(workspaceId, method, params, join(dataDir, 'portal-captures'), signal);
  });
  process_.onEvent((event) => {
    activityMonitor.observeEvent(event);
    window?.webContents.send('orq:event', event);
  });
  process_.setConfirmHandler(async (message) => {
    const result = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Continuar', 'Cancelar'], defaultId: 0, cancelId: 1, message });
    return result.response === 0;
  });
  process_.onUnexpectedExit(async (code) => {
    log.error({ code }, 'o núcleo parou');
    // Spec, seção 7: o núcleo caiu, então encerramos a árvore de cada agente que ele deixou.
    const killed = await killRecordedAgents(join(dataDir, AGENT_PID_FILE), taskkillTree);
    if (killed.length > 0) log.warn({ pids: killed }, 'agentes órfãos encerrados');
    if (quitting || !window) return;
    const answer = await dialog.showMessageBox(window, {
      type: 'error',
      buttons: ['Reiniciar', 'Fechar'],
      message: 'O núcleo do Orquestra parou e os terminais foram encerrados.',
      detail: `Veja o log em ${logDir}.`,
    });
    if (answer.response !== 0) return app.quit();
    host = null;
    try {
      host = await startHost();
    } catch (error) {
      log.error({ err: error }, 'falha ao reiniciar o núcleo');
      dialog.showErrorBox('Orquestra não pôde reiniciar o núcleo', error instanceof OrqError ? error.message : String(error));
      return app.quit();
    }
    window.webContents.reload();
  });
  await process_.start();
  log.info({ nodePath, hostScript }, 'núcleo iniciado');
  return process_;
}

function createWindow(): BrowserWindow {
  const isDev = process.env.ORQ_DEV === '1';
  const created = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0d0f13',
    // Sem barra de título nem menu: ficam só os botões nativos, sobre a faixa .titlebar do renderer.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#13161c', symbolColor: '#d6dae2', height: 32 },
    title: isDev ? 'Orquestra (dev)' : 'Orquestra',
    icon: app.isPackaged ? join(process.resourcesPath, 'orquestra-icon.png') : join(__dirname, '../../build/orquestra-icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
  });
  if (isDev) {
    created.on('page-title-updated', (event) => {
      event.preventDefault();
    });
  }
  // Com o menu removido, o Windows não garante os aceleradores: tratamos as teclas aqui.
  created.webContents.on('before-input-event', (event, input) => {
    const action = appShortcut(input);
    if (!action) return;
    event.preventDefault();
    runAppAction(action);
  });
  created.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.on('minimize', () => {
    portalSystem?.portalManager.setWindowMinimized(true);
  });
  created.on('restore', () => {
    portalSystem?.portalManager.setWindowMinimized(false);
  });
  created.on('show', () => {
    portalSystem?.portalManager.setWindowMinimized(false);
  });
  created.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    portalSystem?.dispose();
    void (host?.stop() ?? Promise.resolve()).finally(() => app.quit());
  });
  if (process.env.ELECTRON_RENDERER_URL) void created.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void created.loadFile(join(__dirname, '../renderer/index.html'));
  return created;
}

function runAppAction(action: unknown): boolean {
  return handleAppAction(action, {
    openLogs: () => void shell.openPath(logDir),
    reload: () => window?.webContents.reload(),
    toggleDevTools: () => window?.webContents.toggleDevTools(),
    openExternal: (url) => void shell.openExternal(url),
    quit: () => app.quit(),
    warn: (message) => log.warn({ component: 'app-action' }, message),
  });
}

ipcMain.handle('orq:app-action', (event, action: unknown) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    log.warn({ component: 'app-action' }, 'ação do app recusada: origem inválida');
    return;
  }
  runAppAction(action);
});

ipcMain.handle('orq:app-info', (event): AppInfo => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    log.warn({ component: 'app-info' }, 'leitura das informações do app recusada: origem inválida');
    throw new Error('Origem de leitura inválida.');
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
  };
});

ipcMain.handle('orq:command', async (_event, method: unknown, params: unknown, workspaceId?: string): Promise<CommandResponse> => {
  if (!window || _event.sender !== window.webContents || _event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { code: 'USAGE', message: 'Origem de comando inválida.' } };
  if (typeof method !== 'string' || !isHostMethod(method)) {
    return { ok: false, error: { code: 'USAGE', message: `Comando desconhecido: ${String(method)}.` } };
  }
  try {
    if (!host) throw new OrqError('APP_UNAVAILABLE', 'O núcleo do Orquestra não está rodando. Reinicie o app.');
    // O núcleo valida os parâmetros com o mesmo schema e devolve USAGE se estiverem errados.
    if (workspaceId !== undefined && typeof workspaceId !== 'string') throw new OrqError('USAGE', 'Workspace inválido.');
    const result = await host.request(method, params as never, workspaceId);
    if (method === 'project.open' || method === 'workspace.activate') {
      const snapshot = result as { workspaceId?: string; dir?: string };
      if (snapshot.workspaceId && snapshot.dir) portalSystem?.portalManager.registerWorkspace(snapshot.workspaceId, snapshot.dir);
    }
    if (method === 'project.close' && workspaceId) portalSystem?.portalManager.destroyWorkspacePortals(workspaceId);
    activityMonitor.observeResult(method, params, result, workspaceId);
    return { ok: true, result };
  } catch (error) {
    const orqError = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do Orquestra. Veja o log.');
    if (orqError.code === 'INTERNAL') log.error({ err: error, method }, 'erro ao repassar comando');
    return { ok: false, error: { code: orqError.code, message: orqError.message } };
  }
});

ipcMain.handle('orq:pick-folder', async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: 'Abrir pasta de projeto' });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('orq:clipboard-read', () => clipboard.readText());
ipcMain.handle('orq:subscription-open', async (_event, provider: unknown) => {
  const urls = { claude: 'https://claude.ai/settings/usage', agy: 'https://one.google.com/', codex: 'https://chatgpt.com/codex/settings/usage' };
  if (typeof provider !== 'string' || !Object.hasOwn(urls, provider)) throw new Error('Assinatura desconhecida.');
  await shell.openExternal(urls[provider as keyof typeof urls]);
});
ipcMain.handle('orq:clipboard-write', (_event, text: unknown) => clipboard.writeText(String(text)));

ipcMain.on('orq:log', (_event, payload: { message?: unknown; stack?: unknown }) => {
  log.error({ component: 'renderer', stack: String(payload.stack ?? '') }, String(payload.message ?? 'erro sem mensagem'));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  void app.whenReady().then(async () => {
    app.setAppUserModelId(appUserModelId(app.isPackaged));
    // Ctrl+R, Ctrl+Shift+I e afins pertencem ao terminal: sem barra de menu, nenhum acelerador do Electron interfere.
    Menu.setApplicationMenu(null);
    try {
      host = await startHost();
    } catch (error) {
      const message = error instanceof OrqError ? error.message : String(error);
      log.error({ err: error }, 'falha ao iniciar o núcleo');
      dialog.showErrorBox('Orquestra não pôde iniciar', message);
      app.quit();
      return;
    }
    portalSystem = initPortalSystem(() => window, {
      register: async (workspaceId, id) => { if (!host) throw new OrqError('APP_UNAVAILABLE', 'Núcleo indisponível.'); await host.request('portal.register', { id, title: 'Navegador' }, workspaceId); },
      unregister: async (workspaceId, id) => { if (host) await host.request('portal.unregister', { id }, workspaceId); },
    });
    window = createWindow();
  });
  app.on('before-quit', () => {
    portalSystem?.dispose();
  });
  app.on('window-all-closed', () => app.quit());
}
