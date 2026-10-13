import type { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import {
  getDevicePreset,
  MAX_PORTALS_PER_WORKSPACE,
  MAX_TABS_PER_PORTAL,
  type DevicePreset,
  type PortalCreateOptions,
  type PortalEvent,
  type PortalMode,
  type PortalNavigationAction,
  type PortalOrientation,
  type PortalState,
  type PortalSyncBoundsPayload,
  type PortalTab,
} from '../../shared/portal-protocol';
import { getOrCreatePortalSession } from './portal-session';
import { PortalView } from './portal-view';
import { executeBrowser } from './browser-agent';
import type { BrowserMethod } from '@orquestra/shared';
import { OrqError } from '@orquestra/shared';
import { join } from 'node:path';

const MAX_WORKSPACES = 3;

interface InternalPortalRecord {
  id: string;
  workspaceId: string;
  activeTabId: string;
  tabs: Map<string, PortalView>;
  mode: PortalMode;
  presetId: string;
  orientation: PortalOrientation;
  zoomLevel: number;
  lastBounds?: { x: number; y: number; width: number; height: number };
  lastVisible?: boolean;
}

export class PortalManager {
  private readonly workspaces = new Map<string, Map<string, InternalPortalRecord>>();
  private readonly workspaceAccessOrder: string[] = [];
  private activeWorkspaceId = '';
  private isModalOpen = false;
  private isWindowMinimized = false;
  private readonly sessionKeys = new Map<string, string>();
  private readonly commands = new Map<string, { tail: Promise<unknown>; count: number }>();

  async agentCommand(workspaceId: string, method: BrowserMethod, raw: unknown, captureRoot: string, signal: AbortSignal): Promise<unknown> {
    const id = (raw as { id?: string })?.id;
    if (!id) throw new OrqError('USAGE', 'Informe o identificador do navegador.');
    const key = `${workspaceId}/${id}`;
    const queue = this.commands.get(key) ?? { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 8) throw new OrqError('APP_UNAVAILABLE', 'Fila do navegador cheia. Aguarde.');
    this.commands.set(key, queue); queue.count++;
    const task = queue.tail.then(async () => {
      const portal = this.workspaces.get(workspaceId)?.get(id), view = portal?.tabs.get(portal.activeTabId);
      if (!portal || !view) throw new OrqError('APP_UNAVAILABLE', 'Abra este navegador no canvas do workspace.');
      const output = await executeBrowser(view.view.webContents, method, raw, join(captureRoot, createHash('sha256').update(key).digest('hex').slice(0, 32)), signal);
      return method === 'portal.check' ? { ...(output as object), id, mode: portal.mode, presetId: portal.presetId } : output;
    });
    queue.tail = task.catch(() => {});
    try { return await task; } finally { queue.count--; if (!queue.count) this.commands.delete(key); }
  }

  registerWorkspace(workspaceId: string, projectDir: string): void {
    this.sessionKeys.set(workspaceId, createHash('sha256').update(projectDir.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 32));
  }

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emitEvent: (event: PortalEvent) => void,
  ) {}

  setActiveWorkspace(workspaceId: string): void {
    if (this.activeWorkspaceId === workspaceId) return;

    // Desanexa views do workspace anterior
    this.detachWorkspaceViews(this.activeWorkspaceId);

    this.activeWorkspaceId = workspaceId;
    this.touchWorkspace(workspaceId);

    // Anexa views do workspace ativo se a janela estiver visível
    this.attachActiveWorkspaceViews();
  }

  setModalState(isOpen: boolean): void {
    this.isModalOpen = isOpen;
    this.updateAllVisibility();
  }

  setWindowMinimized(minimized: boolean): void {
    this.isWindowMinimized = minimized;
    this.updateAllVisibility();
  }

  private touchWorkspace(workspaceId: string): void {
    if (!workspaceId) return;
    const index = this.workspaceAccessOrder.indexOf(workspaceId);
    if (index !== -1) {
      this.workspaceAccessOrder.splice(index, 1);
    }
    this.workspaceAccessOrder.push(workspaceId);

    // Garante no máximo 3 workspaces simultâneos em memória
    while (this.workspaceAccessOrder.length > MAX_WORKSPACES) {
      const oldest = this.workspaceAccessOrder.shift();
      if (oldest && oldest !== this.activeWorkspaceId) {
        this.destroyWorkspacePortals(oldest);
      }
    }
  }

  createPortal(opts: PortalCreateOptions): PortalState {
    const workspaceId = opts.workspaceId || this.activeWorkspaceId || 'default';
    this.touchWorkspace(workspaceId);

    let workspaceMap = this.workspaces.get(workspaceId);
    if (!workspaceMap) {
      workspaceMap = new Map();
      this.workspaces.set(workspaceId, workspaceMap);
    }

    const portalId = opts.portalId;

    // Idempotência: se já existe, atualiza bounds se fornecidos e retorna estado existente
    const existing = workspaceMap.get(portalId);
    if (existing) {
      if (opts.bounds) {
        existing.lastBounds = opts.bounds;
        const activeView = existing.tabs.get(existing.activeTabId);
        if (activeView) activeView.setBounds(opts.bounds);
      }
      return this.serializePortalState(existing);
    }

    // Limite de memória: máximo de portais por workspace
    if (workspaceMap.size >= MAX_PORTALS_PER_WORKSPACE) {
      throw new Error(`Limite máximo de ${MAX_PORTALS_PER_WORKSPACE} portais atingido para o workspace.`);
    }

    const tabId = opts.tabs?.[0]?.id || 'tab-1';
    const session = getOrCreatePortalSession(this.sessionKeys.get(workspaceId) ?? workspaceId);

    const mode = opts.mode ?? 'desktop';
    const presetId = opts.presetId ?? (mode === 'mobile' ? 'iphone-15-pro' : 'desktop-compact');
    const orientation = opts.orientation ?? 'portrait';

    const portalView = new PortalView({
      portalId,
      tabId,
      workspaceId,
      session,
      initialUrl: opts.tabs?.[0]?.url ?? opts.initialUrl ?? 'https://duckduckgo.com',
      presetId,
      orientation,
      onEvent: (event) => this.emitEvent(event),
    });

    if (opts.bounds) {
      portalView.setBounds(opts.bounds);
    }

    const record: InternalPortalRecord = {
      id: portalId,
      workspaceId,
      activeTabId: tabId,
      tabs: new Map([[tabId, portalView]]),
      mode,
      presetId,
      orientation,
      zoomLevel: 1,
      lastBounds: opts.bounds,
      lastVisible: true,
    };

    workspaceMap.set(portalId, record);
    for (const tab of opts.tabs?.slice(1, MAX_TABS_PER_PORTAL) ?? []) {
      if (!tab.id || record.tabs.has(tab.id)) continue;
      record.tabs.set(tab.id, new PortalView({ portalId, tabId: tab.id, workspaceId, session, initialUrl: tab.url, presetId, orientation, onEvent: (event) => this.emitEvent(event) }));
    }
    if (opts.activeTabId && record.tabs.has(opts.activeTabId)) record.activeTabId = opts.activeTabId;

    if (workspaceId === this.activeWorkspaceId && !this.isModalOpen && !this.isWindowMinimized) {
      this.attachView(record.tabs.get(record.activeTabId)!);
    }

    return this.serializePortalState(record);
  }

  navigate(portalId: string, url: string, workspaceId?: string): void {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal) return;

    const activeView = portal.tabs.get(portal.activeTabId);
    if (activeView) {
      void activeView.navigate(url);
    }
  }

  action(portalId: string, act: PortalNavigationAction, workspaceId?: string): void {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal) return;

    const activeView = portal.tabs.get(portal.activeTabId);
    if (activeView) {
      activeView.act(act);
    }
  }

  setMode(
    portalId: string,
    mode: PortalMode,
    presetId?: string,
    orientation?: PortalOrientation,
    workspaceId?: string,
  ): PortalState | null {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal) return null;

    portal.mode = mode;
    if (presetId) portal.presetId = presetId;
    if (orientation) portal.orientation = orientation;

    const preset: DevicePreset = getDevicePreset(portal.presetId);
    for (const view of portal.tabs.values()) {
      view.applyEmulation(preset, portal.orientation);
    }

    return this.serializePortalState(portal);
  }

  syncBounds(payload: PortalSyncBoundsPayload): void {
    const wsId = payload.workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(payload.portalId);
    if (!portal) return;

    portal.lastBounds = payload.bounds;
    portal.lastVisible = payload.visible && !payload.clippedByModal;
    const activeView = portal.tabs.get(portal.activeTabId);
    if (!activeView) return;

    activeView.setBounds(payload.bounds);

    const isCurrentWs = wsId === this.activeWorkspaceId;
    const shouldBeVisible =
      isCurrentWs &&
      portal.lastVisible &&
      !this.isModalOpen &&
      !this.isWindowMinimized;

    activeView.setVisible(shouldBeVisible);
  }

  createTab(portalId: string, initialUrl?: string, workspaceId?: string): PortalState | null {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal) return null;

    if (portal.tabs.size >= MAX_TABS_PER_PORTAL) {
      return this.serializePortalState(portal);
    }

    const newTabId = `tab-${Date.now()}`;
    const session = getOrCreatePortalSession(this.sessionKeys.get(wsId) ?? wsId);

    const newView = new PortalView({
      portalId,
      tabId: newTabId,
      workspaceId: wsId,
      session,
      initialUrl: initialUrl ?? 'about:blank',
      presetId: portal.presetId,
      orientation: portal.orientation,
      onEvent: (event) => this.emitEvent(event),
    });

    if (portal.lastBounds) {
      newView.setBounds(portal.lastBounds);
    }

    portal.tabs.set(newTabId, newView);
    this.switchTab(portalId, newTabId, wsId);

    return this.serializePortalState(portal);
  }

  switchTab(portalId: string, tabId: string, workspaceId?: string): PortalState | null {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal || !portal.tabs.has(tabId)) return null;

    const oldView = portal.tabs.get(portal.activeTabId);
    if (oldView) {
      this.detachView(oldView);
    }

    portal.activeTabId = tabId;
    const newView = portal.tabs.get(tabId)!;

    if (portal.lastBounds) {
      newView.setBounds(portal.lastBounds);
    }

    if (wsId === this.activeWorkspaceId && !this.isModalOpen && !this.isWindowMinimized) {
      this.attachView(newView);
    }

    return this.serializePortalState(portal);
  }

  closeTab(portalId: string, tabId: string, workspaceId?: string): PortalState | null {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    if (!portal || !portal.tabs.has(tabId)) return null;

    // Se só tem uma aba, fecha o portal inteiro
    if (portal.tabs.size <= 1) {
      this.destroyPortal(portalId, wsId);
      return null;
    }

    const viewToClose = portal.tabs.get(tabId)!;
    this.detachView(viewToClose);
    viewToClose.destroy();
    portal.tabs.delete(tabId);

    if (portal.activeTabId === tabId) {
      const nextTabId = Array.from(portal.tabs.keys())[0]!;
      this.switchTab(portalId, nextTabId, wsId);
    }

    return this.serializePortalState(portal);
  }

  destroyPortal(portalId: string, workspaceId?: string): void {
    const wsId = workspaceId || this.activeWorkspaceId;
    const workspaceMap = this.workspaces.get(wsId);
    if (!workspaceMap) return;

    const portal = workspaceMap.get(portalId);
    if (!portal) return;

    for (const view of portal.tabs.values()) {
      this.detachView(view);
      view.destroy();
    }
    portal.tabs.clear();
    workspaceMap.delete(portalId);
  }

  destroyWorkspacePortals(workspaceId: string): void {
    const workspaceMap = this.workspaces.get(workspaceId);
    if (!workspaceMap) return;

    for (const portal of workspaceMap.values()) {
      for (const view of portal.tabs.values()) {
        this.detachView(view);
        view.destroy();
      }
      portal.tabs.clear();
    }
    workspaceMap.clear();
    this.workspaces.delete(workspaceId);
    this.sessionKeys.delete(workspaceId);

    const idx = this.workspaceAccessOrder.indexOf(workspaceId);
    if (idx !== -1) {
      this.workspaceAccessOrder.splice(idx, 1);
    }
  }

  destroyAll(): void {
    for (const workspaceId of Array.from(this.workspaces.keys())) {
      this.destroyWorkspacePortals(workspaceId);
    }
  }

  private attachView(portalView: PortalView): void {
    const win = this.getWindow();
    if (!win) return;
    try {
      win.contentView.addChildView(portalView.view);
      portalView.setVisible(true);
    } catch {
      // Ignora erro se já estiver anexada ou destruída
    }
  }

  private detachView(portalView: PortalView): void {
    const win = this.getWindow();
    if (!win) return;
    try {
      portalView.setVisible(false);
      win.contentView.removeChildView(portalView.view);
    } catch {
      // Ignora se não estiver anexada
    }
  }

  private attachActiveWorkspaceViews(): void {
    if (this.isModalOpen || this.isWindowMinimized) return;
    const workspaceMap = this.workspaces.get(this.activeWorkspaceId);
    if (!workspaceMap) return;

    for (const portal of workspaceMap.values()) {
      const activeView = portal.tabs.get(portal.activeTabId);
      if (activeView) {
        this.attachView(activeView);
      }
    }
  }

  private detachWorkspaceViews(workspaceId: string): void {
    const workspaceMap = this.workspaces.get(workspaceId);
    if (!workspaceMap) return;

    for (const portal of workspaceMap.values()) {
      for (const view of portal.tabs.values()) {
        this.detachView(view);
      }
    }
  }

  private updateAllVisibility(): void {
    const hideAll = this.isModalOpen || this.isWindowMinimized;
    const workspaceMap = this.workspaces.get(this.activeWorkspaceId);
    if (!workspaceMap) return;

    for (const portal of workspaceMap.values()) {
      const activeView = portal.tabs.get(portal.activeTabId);
      if (activeView) {
        if (hideAll) {
          activeView.setVisible(false);
        } else {
          // Preserva visibilidade prévia para não reexibir nós clipped ou fora da área
          activeView.setVisible(portal.lastVisible ?? true);
        }
      }
    }
  }

  getPortalState(portalId: string, workspaceId?: string): PortalState | null {
    const wsId = workspaceId || this.activeWorkspaceId;
    const portal = this.workspaces.get(wsId)?.get(portalId);
    return portal ? this.serializePortalState(portal) : null;
  }

  getAllPortalStates(workspaceId?: string): PortalState[] {
    const wsId = workspaceId || this.activeWorkspaceId;
    const workspaceMap = this.workspaces.get(wsId);
    if (!workspaceMap) return [];
    return Array.from(workspaceMap.values()).map((p) => this.serializePortalState(p));
  }

  private serializePortalState(portal: InternalPortalRecord): PortalState {
    const tabs: PortalTab[] = Array.from(portal.tabs.entries()).map(([tabId, view]) => ({
      id: tabId,
      url: view.getUrl(),
      title: view.getTitle(),
      favicon: view.getFavicon(),
      isLoading: view.isLoading(),
      canGoBack: view.canGoBack(),
      canGoForward: view.canGoForward(),
    }));

    return {
      id: portal.id,
      workspaceId: portal.workspaceId,
      activeTabId: portal.activeTabId,
      tabs,
      mode: portal.mode,
      presetId: portal.presetId,
      orientation: portal.orientation,
      zoomLevel: portal.zoomLevel,
      isAttached: portal.workspaceId === this.activeWorkspaceId,
      visible: portal.workspaceId === this.activeWorkspaceId && (portal.lastVisible ?? true) && !this.isModalOpen && !this.isWindowMinimized,
      bounds: portal.lastBounds,
    };
  }
}
