import type { HostEvent } from '@orquestra/shared/host-protocol';
import type { OutputBus } from './output-bus';
import type { AppActions } from './store';
import { activeWorkspaceId, outputKey } from './workspace-context';
import { workspaceStore } from './workspaces';

const transitions = new Map<string, HostEvent[]>();
const sequences = new Map<string, number>();
export function forgetWorkspaceEvents(id: string): void { transitions.delete(id); sequences.delete(id); }
export function flushWorkspaceEvents(store: Pick<AppActions, 'applyEvent'>, workspaceId = activeWorkspaceId(), afterSequence?: number): void {
  if (workspaceId) {
    let seen = afterSequence ?? sequences.get(workspaceId) ?? 0;
    for (const event of transitions.get(workspaceId) ?? []) {
      const notice = event.type === 'notice' || event.type === 'terminal.notice';
      if (!notice && event.sequence !== undefined && event.sequence <= seen) continue;
      store.applyEvent(event);
      seen = Math.max(event.sequence ?? seen, seen);
    }
    sequences.set(workspaceId, seen);
  }
  transitions.clear();
}

export function routeEvent(event: HostEvent, deps: { store: Pick<AppActions, 'applyEvent'>; bus: OutputBus }): void {
  if (event.workspaceId && event.type !== 'terminal.output' && workspaceStore.getState().changing) {
    const buffered = transitions.get(event.workspaceId) ?? [];
    buffered.push(event);
    transitions.set(event.workspaceId, buffered);
    return;
  }
  if (event.workspaceId && event.workspaceId !== activeWorkspaceId()) return;
  if (event.type === 'terminal.output') return deps.bus.publish(outputKey(event.name, event.workspaceId), event.data);
  if (event.workspaceId && event.sequence !== undefined && event.sequence <= (sequences.get(event.workspaceId) ?? 0)) return;
  deps.store.applyEvent(event);
  if (event.workspaceId && event.sequence !== undefined) sequences.set(event.workspaceId, event.sequence);
}
