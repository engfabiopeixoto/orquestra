import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { PortalMode, PortalOrientation, PortalState, PortalTab } from '../../../shared/portal-protocol';
import { appStore } from '../store';
import { workspaceStore } from '../workspaces';

interface PortalStoreState {
  portals: Record<string, PortalState>;
  setPortal(portal: PortalState): void;
  updatePortal(id: string, patch: Partial<PortalState>): void;
  removePortal(id: string): void;
  updateTab(portalId: string, tabId: string, patch: Partial<PortalTab>): void;
  loadFromStorage(workspaceId: string): void;
  saveToStorage(workspaceId: string): void;
}

const STORAGE_PREFIX = 'orq:portals:ws:';
function storageKey(workspaceId: string): string {
  const project = appStore.getState().project;
  const dir = project?.workspaceId === workspaceId ? project.dir : workspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.dir;
  return dir ? `orq:portals:project:${encodeURIComponent(dir.replace(/\\/g, '/').toLowerCase())}` : `${STORAGE_PREFIX}${workspaceId || 'default'}`;
}

export const portalStore = createStore<PortalStoreState>((set, get) => ({
  portals: {},

  setPortal: (portal) => {
    const previous = get().portals[portal.id];
    portal = { ...portal, position: portal.position ?? previous?.position, size: portal.size ?? previous?.size };
    set((state) => ({
      portals: { ...state.portals, [portal.id]: portal },
    }));
    get().saveToStorage(portal.workspaceId);
  },

  updatePortal: (id, patch) => {
    const existing = get().portals[id];
    if (!existing) return;
    const updated = { ...existing, ...patch };
    set((state) => ({
      portals: { ...state.portals, [id]: updated },
    }));
    get().saveToStorage(updated.workspaceId);
  },

  removePortal: (id) => {
    const existing = get().portals[id];
    if (!existing) return;
    const { [id]: _removed, ...rest } = get().portals;
    set({ portals: rest });
    get().saveToStorage(existing.workspaceId);
  },

  updateTab: (portalId, tabId, patch) => {
    const portal = get().portals[portalId];
    if (!portal) return;
    const tabs = portal.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab));
    const updated = { ...portal, tabs };
    set((state) => ({
      portals: { ...state.portals, [portalId]: updated },
    }));
    get().saveToStorage(updated.workspaceId);
  },

  loadFromStorage: (workspaceId: string) => {
    try {
      const raw = localStorage.getItem(storageKey(workspaceId)) ?? localStorage.getItem(`${STORAGE_PREFIX}${workspaceId || 'default'}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, PortalState>;
      set((state) => ({
        portals: { ...state.portals, ...Object.fromEntries(Object.entries(parsed).slice(0, 2).filter(([, portal]) => portal && typeof portal.id === 'string' && Array.isArray(portal.tabs)).map(([id, portal]) => [id, { ...portal, workspaceId, tabs: portal.tabs.slice(0, 3) }])) },
      }));
    } catch {
      // Ignora erro de parsing no storage
    }
  },

  saveToStorage: (workspaceId: string) => {
    try {
      const wsId = workspaceId || 'default';
      const forWs: Record<string, PortalState> = {};
      for (const [id, p] of Object.entries(get().portals)) {
        if (p.workspaceId === wsId) {
          forWs[id] = p;
        }
      }
      localStorage.setItem(storageKey(wsId), JSON.stringify(forWs));
    } catch {
      // Ignora erro no storage
    }
  },
}));

export const usePortalStore = <T>(selector: (state: PortalStoreState) => T) =>
  useStore(portalStore, selector);
