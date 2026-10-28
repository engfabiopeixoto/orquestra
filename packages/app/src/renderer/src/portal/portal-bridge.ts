import {
  PORTAL_IPC,
  type PortalCreateOptions,
  type PortalEvent,
  type PortalMode,
  type PortalNavigationAction,
  type PortalOrientation,
  type PortalState,
  type PortalSyncBoundsPayload,
} from '../../../shared/portal-protocol';

export interface PortalBridgeApi {
  create(opts: PortalCreateOptions): Promise<PortalState>;
  navigate(portalId: string, url: string, workspaceId?: string): Promise<void>;
  action(portalId: string, action: PortalNavigationAction, workspaceId?: string): Promise<void>;
  syncBounds(payload: PortalSyncBoundsPayload): Promise<void>;
  setMode(
    portalId: string,
    mode: PortalMode,
    presetId?: string,
    orientation?: PortalOrientation,
    workspaceId?: string,
  ): Promise<PortalState | null>;
  createTab(portalId: string, initialUrl?: string, workspaceId?: string): Promise<PortalState | null>;
  switchTab(portalId: string, tabId: string, workspaceId?: string): Promise<PortalState | null>;
  closeTab(portalId: string, tabId: string, workspaceId?: string): Promise<PortalState | null>;
  destroy(portalId: string, workspaceId?: string): Promise<void>;
  getState(portalId: string, workspaceId?: string): Promise<PortalState | null>;
  onEvent(listener: (event: PortalEvent) => void): () => void;
}

declare global {
  interface Window {
    __orqPortalBridge?: PortalBridgeApi;
  }
}

/**
 * Cria uma ponte simulada em memória para testes unitários ou ambientes sem Electron
 */
export function createInMemoryPortalBridge(): PortalBridgeApi {
  const states = new Map<string, PortalState>();
  const listeners = new Set<(event: PortalEvent) => void>();

  return {
    async create(opts) {
      const state: PortalState = {
        id: opts.portalId,
        workspaceId: opts.workspaceId,
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            url: opts.initialUrl ?? 'https://duckduckgo.com',
            title: 'Novo Portal',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ],
        mode: opts.mode ?? 'desktop',
        presetId: opts.presetId ?? 'desktop-compact',
        orientation: opts.orientation ?? 'portrait',
        zoomLevel: 1,
        isAttached: true,
        visible: true,
        bounds: opts.bounds,
      };
      states.set(opts.portalId, state);
      return state;
    },
    async navigate(portalId, url) {
      const state = states.get(portalId);
      if (!state) return;
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab) {
        tab.url = url;
        tab.title = url;
      }
      for (const l of listeners) {
        l({ type: 'portal:navigated', portalId, tabId: state.activeTabId, url, canGoBack: false, canGoForward: false });
      }
    },
    async action(portalId, action) {
      const state = states.get(portalId);
      if (!state) return;
      if (action === 'reload') {
        for (const l of listeners) {
          l({ type: 'portal:loading', portalId, tabId: state.activeTabId, isLoading: true });
        }
      }
    },
    async syncBounds(payload) {
      const state = states.get(payload.portalId);
      if (!state) return;
      state.bounds = payload.bounds;
      state.visible = payload.visible;
    },
    async setMode(portalId, mode, presetId, orientation) {
      const state = states.get(portalId);
      if (!state) return null;
      state.mode = mode;
      if (presetId) state.presetId = presetId;
      if (orientation) state.orientation = orientation;
      return { ...state };
    },
    async createTab(portalId, initialUrl) {
      const state = states.get(portalId);
      if (!state) return null;
      const newTabId = `tab-${state.tabs.length + 1}`;
      state.tabs.push({
        id: newTabId,
        url: initialUrl ?? 'about:blank',
        title: 'Nova Aba',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      });
      state.activeTabId = newTabId;
      return { ...state };
    },
    async switchTab(portalId, tabId) {
      const state = states.get(portalId);
      if (!state || !state.tabs.some((t) => t.id === tabId)) return null;
      state.activeTabId = tabId;
      return { ...state };
    },
    async closeTab(portalId, tabId) {
      const state = states.get(portalId);
      if (!state) return null;
      state.tabs = state.tabs.filter((t) => t.id !== tabId);
      if (state.tabs.length === 0) {
        states.delete(portalId);
        return null;
      }
      state.activeTabId = state.tabs[0]!.id;
      return { ...state };
    },
    async destroy(portalId) {
      states.delete(portalId);
    },
    async getState(portalId) {
      return states.get(portalId) ?? null;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let activeBridge: PortalBridgeApi | null = null;

export function getPortalBridge(): PortalBridgeApi {
  if (activeBridge) return activeBridge;

  // 1. Injetado explicitamente para testes
  if (window.__orqPortalBridge) {
    return window.__orqPortalBridge;
  }

  // 2. Bridge oficial tipada exposta pelo preload
  if (window?.orquestra?.portal) {
    return window.orquestra.portal as unknown as PortalBridgeApi;
  }

  // 3. Em testes automatizados fora do Electron, usa fallback in-memory
  const isTest = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST));
  if (isTest) {
    activeBridge = createInMemoryPortalBridge();
    return activeBridge;
  }

  throw new Error('Ponte do portal não encontrada: window.orquestra.portal indisponível.');
}

export function setPortalBridge(bridge: PortalBridgeApi | null): void {
  activeBridge = bridge;
}
