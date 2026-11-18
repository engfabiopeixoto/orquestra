import type { HostEvent, TerminalInfo } from '@orquestra/shared/host-protocol';

export type NotificationPermissionState = NotificationPermission | 'unsupported';

export type MobileNotificationPayload = {
  title: string;
  options: NotificationOptions & { vibrate?: number[]; renotify?: boolean };
};

export type MobileNotifierDeps = {
  getPermission?: () => NotificationPermissionState;
  isPageVisible?: () => boolean;
  showNotification?: (title: string, options: NotificationOptions & { vibrate?: number[]; renotify?: boolean }) => Promise<void> | void;
};

export function readNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window) || typeof Notification.requestPermission !== 'function') {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return readNotificationPermission();
  }
}

export async function showServiceWorkerNotification(
  title: string,
  options: NotificationOptions & { vibrate?: number[]; renotify?: boolean },
): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, options);
    }
  } catch {
    // Falha silenciosa caso o service worker ainda não esteja ativo.
  }
}

export function registerMobileServiceWorker(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export type DeepLinkTarget = {
  workspaceId?: string;
  terminal?: string;
};

export function parseDeepLinkTarget(search: string = typeof window !== 'undefined' ? window.location.search : ''): DeepLinkTarget | null {
  const params = new URLSearchParams(search);
  const workspaceId = params.get('workspace')?.trim() || undefined;
  const terminal = params.get('terminal')?.trim() || undefined;
  if (!workspaceId && !terminal) return null;
  return { workspaceId, terminal };
}

export function isOpenTerminalMessage(data: unknown): data is { type: 'orquestra:open-terminal'; workspaceId?: string; terminal?: string } {
  return (
    Boolean(data) &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'orquestra:open-terminal'
  );
}

/**
 * Decide quando mostrar notificações no celular:
 * - somente com permissão 'granted' e página oculta (visibilityState !== 'visible');
 * - quando um terminal entra em 'waiting' (terminal.state) ou termina um turno (terminal.turn);
 * - nunca inclui conteúdo do terminal; usa tag por terminal para não empilhar.
 */
export class MobileNotifier {
  private readonly states = new Map<string, TerminalInfo['state']>();
  private readonly getPermission: () => NotificationPermissionState;
  private readonly isPageVisible: () => boolean;
  private readonly showNotification: (title: string, options: NotificationOptions & { vibrate?: number[]; renotify?: boolean }) => Promise<void> | void;

  constructor(deps: MobileNotifierDeps = {}) {
    this.getPermission = deps.getPermission ?? readNotificationPermission;
    this.isPageVisible =
      deps.isPageVisible ??
      (() => (typeof document !== 'undefined' ? document.visibilityState === 'visible' : true));
    this.showNotification = deps.showNotification ?? showServiceWorkerNotification;
  }

  private keyOf(workspaceId: string | undefined, name: string): string {
    return `${workspaceId ?? ''}:${name}`;
  }

  seedSnapshot(snapshot: { workspaceId?: string; terminals: Pick<TerminalInfo, 'name' | 'state'>[] }): void {
    const prefix = `${snapshot.workspaceId ?? ''}:`;
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) this.states.delete(key);
    }
    for (const terminal of snapshot.terminals) {
      this.states.set(this.keyOf(snapshot.workspaceId, terminal.name), terminal.state);
    }
  }

  observeEvent(event: HostEvent): void {
    const wsId = event.workspaceId;
    if (event.type === 'terminal.added' || event.type === 'terminal.replaced') {
      if (event.type === 'terminal.replaced' && event.oldName) {
        this.states.delete(this.keyOf(wsId, event.oldName));
      }
      this.states.set(this.keyOf(wsId, event.info.name), event.info.state);
      return;
    }
    if (event.type === 'terminal.removed') {
      this.states.delete(this.keyOf(wsId, event.name));
      return;
    }
    if (event.type === 'terminal.state') {
      const key = this.keyOf(wsId, event.name);
      const prev = this.states.get(key);
      this.states.set(key, event.state);
      if (event.state === 'waiting' && prev !== 'waiting') {
        this.emit(event.name, wsId, `${event.name} está esperando você`);
      }
      return;
    }
    if (event.type === 'terminal.turn') {
      if (event.owner === 'user') {
        this.emit(event.name, wsId, `${event.name} terminou`);
      }
    }
  }

  private emit(terminalName: string, workspaceId: string | undefined, title: string): void {
    if (this.getPermission() !== 'granted') return;
    if (this.isPageVisible()) return;
    const tag = workspaceId ? `orquestra:${workspaceId}:${terminalName}` : `orquestra:${terminalName}`;
    void this.showNotification(title, {
      tag,
      vibrate: [200, 100, 200],
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: {
        workspaceId,
        terminal: terminalName,
      },
    });
  }
}
