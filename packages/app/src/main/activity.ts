import type { HostEvent, HostMethod, TerminalInfo } from '@orquestra/shared/host-protocol';

export type NotifyReason = 'turn' | 'waiting';
const REPEAT_MS = 10_000;

export function shouldNotify(input: { focused: boolean; monitor: boolean; reason: NotifyReason; lastNotifiedAt: number | undefined; now: number }): boolean {
  if (input.focused || !input.monitor) return false;
  return input.lastNotifiedAt === undefined || input.now - input.lastNotifiedAt >= REPEAT_MS;
}

type Tracked = { agent: string; monitor: boolean; state: TerminalInfo['state'] };

/** Decide as notificações a partir do que o principal já repassa: respostas de comandos e eventos do núcleo. */
export class ActivityMonitor {
  private readonly terminals = new Map<string, Tracked>();
  private readonly lastNotified = new Map<string, number>();
  private project: string | null = null;
  private selectedId: string | undefined;
  private readonly workspaces = new Map<string, ActivityMonitor>();

  constructor(private readonly opts: { isFocused: () => boolean; notify: (n: { name: string; title: string; body: string; workspaceId?: string }) => void; now?: () => number }) {}

  private workspace(id: string): ActivityMonitor {
    let monitor = this.workspaces.get(id);
    if (!monitor) {
      monitor = new ActivityMonitor({ ...this.opts, isFocused: () => this.selectedId === id && this.opts.isFocused(), notify: (notice) => this.opts.notify({ ...notice, workspaceId: id }) });
      this.workspaces.set(id, monitor);
    }
    return monitor;
  }

  observeResult(method: HostMethod, params: unknown, result: unknown, workspaceId?: string): void {
    const snapshotId = (method === 'project.open' || method === 'workspace.activate') ? (result as { workspaceId?: string }).workspaceId : undefined;
    const id = snapshotId ?? workspaceId;
    if (id) {
      if (snapshotId) this.selectedId = snapshotId;
      const unscoped = snapshotId ? { ...(result as object), workspaceId: undefined } : result;
      this.workspace(id).observeResult(method === 'workspace.activate' ? 'project.open' : method, params, unscoped);
      if (method === 'project.close') { this.workspaces.delete(id); if (this.selectedId === id) this.selectedId = undefined; }
      return;
    }
    if (method === 'project.open') {
      const snapshot = result as { name: string; terminals: TerminalInfo[] };
      this.project = snapshot.name;
      this.terminals.clear();
      for (const info of snapshot.terminals) this.track(info);
    } else if (method === 'terminal.create' || method === 'terminal.restart' || method === 'terminal.unload' || method === 'terminal.presentation') {
      this.track(result as TerminalInfo);
    } else if (method === 'terminal.duplicate') {
      this.track((result as { info: TerminalInfo }).info);
    } else if (method === 'terminal.update' || method === 'terminal.rename') {
      const { name } = params as { name: string };
      this.terminals.delete(name);
      this.track(result as TerminalInfo);
    } else if (method === 'project.close') {
      this.project = null;
      this.terminals.clear();
    }
  }

  observeEvent(event: HostEvent): void {
    if (event.workspaceId) {
      const { workspaceId, ...unscoped } = event;
      this.workspace(workspaceId).observeEvent(unscoped);
      return;
    }
    if (event.type === 'terminal.added') return this.track(event.info);
    if (event.type === 'terminal.removed') {
      this.terminals.delete(event.name);
      return;
    }
    if (event.type === 'terminal.state') {
      const tracked = this.terminals.get(event.name);
      if (!tracked) return;
      const entered = event.state === 'waiting' && tracked.state !== 'waiting';
      tracked.state = event.state;
      if (entered) this.consider(event.name, 'waiting');
      return;
    }
    if (event.type === 'terminal.turn' && event.owner === 'user') this.consider(event.name, 'turn');
  }

  private track(info: TerminalInfo): void {
    this.terminals.set(info.name, { agent: info.agent, monitor: info.monitor, state: info.state });
  }

  private consider(name: string, reason: NotifyReason): void {
    const tracked = this.terminals.get(name);
    if (!tracked) return;
    const now = (this.opts.now ?? Date.now)();
    const key = `${name}\u0000${reason}`;
    if (!shouldNotify({ focused: this.opts.isFocused(), monitor: tracked.monitor, reason, lastNotifiedAt: this.lastNotified.get(key), now })) return;
    this.lastNotified.set(key, now);
    const title = reason === 'turn' ? `${name} terminou` : `${name} está aguardando você`;
    const body = this.project ? `${tracked.agent} · ${this.project}` : tracked.agent;
    this.opts.notify({ name, title, body });
  }
}
