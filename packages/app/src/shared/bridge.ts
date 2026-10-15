import type { ErrorCode, HostEvent } from '@orquestra/shared';
import type { AppAction } from './app-action';
import type {
  PortalCreateOptions,
  PortalEvent,
  PortalMode,
  PortalNavigationAction,
  PortalOrientation,
  PortalState,
  PortalSyncBoundsPayload,
} from './portal-protocol';

export type CommandResponse = { ok: true; result: unknown } | { ok: false; error: { code: ErrorCode; message: string } };
export type AppInfo = {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
};

export interface OrquestraPortalBridge {
  create(opts: PortalCreateOptions): Promise<PortalState>;
  navigate(portalId: string, url: string, workspaceId?: string): Promise<{ ok: boolean }>;
  action(portalId: string, action: PortalNavigationAction, workspaceId?: string): Promise<{ ok: boolean }>;
  syncBounds(payload: PortalSyncBoundsPayload): Promise<{ ok: boolean }>;
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
  destroy(portalId: string, workspaceId?: string): Promise<{ ok: boolean }>;
  setActiveWorkspace(workspaceId: string): Promise<{ ok: boolean }>;
  setModalState(isOpen: boolean): Promise<{ ok: boolean }>;
  getState(portalId: string, workspaceId?: string): Promise<PortalState | null>;
  onEvent(listener: (event: PortalEvent) => void): () => void;
}

export interface OrquestraBridge {
  invoke(method: string, params: unknown, workspaceId?: string): Promise<CommandResponse>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  pickFolder(): Promise<string | null>;
  openSubscription(provider: 'claude' | 'agy' | 'codex'): Promise<void>;
  /** Ações do menu da janela (a barra de menu foi removida). */
  appAction(action: AppAction): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  reportError(message: string, stack?: string): void;
  /** Área de transferência do sistema, pelo Electron (o navigator.clipboard pede permissão e falha sem foco). */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  onFocusTerminal(listener: (name: string, workspaceId?: string) => void): () => void;
  readonly testProject: string | null;
  readonly portal: OrquestraPortalBridge;
}

declare global {
  interface Window {
    orquestra: OrquestraBridge;
  }
}
