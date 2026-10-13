import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HostEvent } from '@orquestra/shared';
import type { CommandResponse, OrquestraBridge } from '../shared/bridge';
import { PORTAL_IPC, type PortalEvent } from '../shared/portal-protocol';

let selectedWorkspace: string | undefined;
const bridge: OrquestraBridge = {
  invoke: async (method, params, workspaceId = selectedWorkspace) => {
    const response = await ipcRenderer.invoke('orq:command', method, params, workspaceId) as CommandResponse;
    if (response.ok && (method === 'project.open' || method === 'workspace.activate')) {
      selectedWorkspace = (response.result as { workspaceId?: string }).workspaceId;
      if (selectedWorkspace) void ipcRenderer.invoke(PORTAL_IPC.SET_ACTIVE_WORKSPACE, { workspaceId: selectedWorkspace });
    }
    if (response.ok && method === 'project.close' && workspaceId === selectedWorkspace) selectedWorkspace = undefined;
    return response;
  },
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, hostEvent: HostEvent) => listener(hostEvent);
    ipcRenderer.on('orq:event', handler);
    return () => ipcRenderer.off('orq:event', handler);
  },
  pickFolder: () => ipcRenderer.invoke('orq:pick-folder') as Promise<string | null>,
  openSubscription: (provider) => ipcRenderer.invoke('orq:subscription-open', provider) as Promise<void>,
  reportError: (message, stack) => ipcRenderer.send('orq:log', { message, stack }),
  // O Electron 44 não expõe o clipboard no preload: a leitura e a escrita passam pelo principal.
  readClipboard: () => ipcRenderer.invoke('orq:clipboard-read') as Promise<string>,
  writeClipboard: (text) => ipcRenderer.invoke('orq:clipboard-write', text) as Promise<void>,
  onFocusTerminal: (listener) => {
    const handler = (_event: IpcRendererEvent, name: string, workspaceId?: string) => listener(name, workspaceId);
    ipcRenderer.on('orq:focus-terminal', handler);
    return () => ipcRenderer.off('orq:focus-terminal', handler);
  },
  testProject: process.env.ORQ_E2E_PROJECT ?? null,
  portal: {
    create: (opts) => ipcRenderer.invoke(PORTAL_IPC.CREATE, opts),
    navigate: (portalId, url, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.NAVIGATE, { portalId, url, workspaceId }),
    action: (portalId, action, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.ACTION, { portalId, action, workspaceId }),
    syncBounds: (payload) =>
      ipcRenderer.invoke(PORTAL_IPC.SYNC_BOUNDS, { ...payload, workspaceId: payload.workspaceId || selectedWorkspace }),
    setMode: (portalId, mode, presetId, orientation, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.SET_MODE, { portalId, mode, presetId, orientation, workspaceId }),
    createTab: (portalId, initialUrl, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.CREATE_TAB, { portalId, initialUrl, workspaceId }),
    switchTab: (portalId, tabId, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.SWITCH_TAB, { portalId, tabId, workspaceId }),
    closeTab: (portalId, tabId, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.CLOSE_TAB, { portalId, tabId, workspaceId }),
    destroy: (portalId, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.DESTROY, { portalId, workspaceId }),
    setActiveWorkspace: (workspaceId) =>
      ipcRenderer.invoke(PORTAL_IPC.SET_ACTIVE_WORKSPACE, { workspaceId }),
    setModalState: (isOpen) =>
      ipcRenderer.invoke(PORTAL_IPC.SET_MODAL_STATE, { isOpen }),
    getState: (portalId, workspaceId = selectedWorkspace) =>
      ipcRenderer.invoke(PORTAL_IPC.GET_STATE, { portalId, workspaceId }),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, portalEvent: PortalEvent) => listener(portalEvent);
      ipcRenderer.on(PORTAL_IPC.EVENT, handler);
      return () => ipcRenderer.off(PORTAL_IPC.EVENT, handler);
    },
  },
};

contextBridge.exposeInMainWorld('orquestra', bridge);
