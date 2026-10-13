import { ipcMain, type BrowserWindow } from 'electron';
import {
  PORTAL_IPC,
  type PortalCreateOptions,
  type PortalEvent,
  type PortalMode,
  type PortalNavigationAction,
  type PortalOrientation,
  type PortalSyncBoundsPayload,
} from '../../shared/portal-protocol';
import { PortalManager } from './portal-manager';
type PortalLifecycle = { register(workspaceId: string, id: string): Promise<void>; unregister(workspaceId: string, id: string): Promise<void> };

export function setupPortalIpc(
  portalManager: PortalManager,
  getWindow?: () => BrowserWindow | null,
  lifecycle?: PortalLifecycle,
): () => void {
  function validateSender(event: Electron.IpcMainInvokeEvent): void {
    if (!getWindow) return;
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Não autorizado: origem IPC inválida');
    }
  }

  ipcMain.handle(PORTAL_IPC.CREATE, async (event, opts: PortalCreateOptions) => {
    validateSender(event);
    if (!opts || typeof opts.portalId !== 'string' || !opts.portalId.trim()) {
      throw new Error('Parâmetros inválidos para create portal');
    }
    const state = portalManager.createPortal(opts);
    try { await lifecycle?.register(state.workspaceId, state.id); return state; }
    catch (error) { portalManager.destroyPortal(state.id, state.workspaceId); throw error; }
  });

  ipcMain.handle(
    PORTAL_IPC.NAVIGATE,
    (event, payload: { portalId: string; url: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string' || typeof payload.url !== 'string') {
        throw new Error('Parâmetros inválidos para navigate');
      }
      portalManager.navigate(payload.portalId, payload.url, payload.workspaceId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    PORTAL_IPC.ACTION,
    (event, payload: { portalId: string; action: PortalNavigationAction; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string' || !payload.action) {
        throw new Error('Parâmetros inválidos para action');
      }
      portalManager.action(payload.portalId, payload.action, payload.workspaceId);
      return { ok: true };
    },
  );

  ipcMain.handle(PORTAL_IPC.SYNC_BOUNDS, (event, payload: PortalSyncBoundsPayload) => {
    validateSender(event);
    if (!payload || typeof payload.portalId !== 'string' || !payload.bounds) {
      throw new Error('Parâmetros inválidos para syncBounds');
    }
    portalManager.syncBounds(payload);
    return { ok: true };
  });

  ipcMain.handle(
    PORTAL_IPC.SET_MODE,
    (
      event,
      payload: {
        portalId: string;
        mode: PortalMode;
        presetId?: string;
        orientation?: PortalOrientation;
        workspaceId?: string;
      },
    ) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string' || (payload.mode !== 'desktop' && payload.mode !== 'mobile')) {
        throw new Error('Parâmetros inválidos para setMode');
      }
      return portalManager.setMode(
        payload.portalId,
        payload.mode,
        payload.presetId,
        payload.orientation,
        payload.workspaceId,
      );
    },
  );

  ipcMain.handle(
    PORTAL_IPC.CREATE_TAB,
    (event, payload: { portalId: string; initialUrl?: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string') {
        throw new Error('Parâmetros inválidos para createTab');
      }
      return portalManager.createTab(payload.portalId, payload.initialUrl, payload.workspaceId);
    },
  );

  ipcMain.handle(
    PORTAL_IPC.SWITCH_TAB,
    async (event, payload: { portalId: string; tabId: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string' || typeof payload.tabId !== 'string') {
        throw new Error('Parâmetros inválidos para switchTab');
      }
      return portalManager.switchTab(payload.portalId, payload.tabId, payload.workspaceId);
    },
  );

  ipcMain.handle(
    PORTAL_IPC.CLOSE_TAB,
    async (event, payload: { portalId: string; tabId: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string' || typeof payload.tabId !== 'string') {
        throw new Error('Parâmetros inválidos para closeTab');
      }
      const state = portalManager.closeTab(payload.portalId, payload.tabId, payload.workspaceId);
      if (!state && payload.workspaceId) await lifecycle?.unregister(payload.workspaceId, payload.portalId);
      return state;
    },
  );

  ipcMain.handle(
    PORTAL_IPC.DESTROY,
    async (event, payload: { portalId: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string') {
        throw new Error('Parâmetros inválidos para destroy');
      }
      portalManager.destroyPortal(payload.portalId, payload.workspaceId);
      if (payload.workspaceId) await lifecycle?.unregister(payload.workspaceId, payload.portalId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    PORTAL_IPC.SET_ACTIVE_WORKSPACE,
    (event, payload: { workspaceId: string }) => {
      validateSender(event);
      if (!payload || typeof payload.workspaceId !== 'string') {
        throw new Error('Parâmetros inválidos para setActiveWorkspace');
      }
      portalManager.setActiveWorkspace(payload.workspaceId);
      return { ok: true };
    },
  );

  ipcMain.handle(PORTAL_IPC.SET_MODAL_STATE, (event, payload: { isOpen: boolean }) => {
    validateSender(event);
    if (!payload || typeof payload.isOpen !== 'boolean') {
      throw new Error('Parâmetros inválidos para setModalState');
    }
    portalManager.setModalState(payload.isOpen);
    return { ok: true };
  });

  ipcMain.handle(
    PORTAL_IPC.GET_STATE,
    async (event, payload: { portalId: string; workspaceId?: string }) => {
      validateSender(event);
      if (!payload || typeof payload.portalId !== 'string') {
        throw new Error('Parâmetros inválidos para getState');
      }
      const state = portalManager.getPortalState(payload.portalId, payload.workspaceId);
      if (state) await lifecycle?.register(state.workspaceId, state.id);
      return state;
    },
  );

  return () => {
    for (const channel of Object.values(PORTAL_IPC)) {
      if (channel !== PORTAL_IPC.EVENT) {
        ipcMain.removeHandler(channel);
      }
    }
  };
}

export function initPortalSystem(getWindow: () => BrowserWindow | null, lifecycle?: PortalLifecycle): {
  portalManager: PortalManager;
  dispose: () => void;
} {
  const portalManager = new PortalManager(getWindow, (event: PortalEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(PORTAL_IPC.EVENT, event);
    }
  });

  const cleanupIpc = setupPortalIpc(portalManager, getWindow, lifecycle);

  return {
    portalManager,
    dispose: () => {
      cleanupIpc();
      portalManager.destroyAll();
    },
  };
}
