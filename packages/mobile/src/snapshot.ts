import type { HostEvent } from '@orquestra/shared/host-protocol';
import type { RemoteSnapshot as ProjectSnapshot } from '@orquestra/shared/remote-snapshot';

/**
 * Aplica um evento do host ao snapshot do workspace exibido.
 * Eventos com `sequence` menor ou igual ao `eventSequence` do snapshot já estão refletidos nele e são ignorados.
 */
export function applyEventToSnapshot(prev: ProjectSnapshot, event: HostEvent): ProjectSnapshot {
  if (event.sequence !== undefined && prev.eventSequence !== undefined && event.sequence <= prev.eventSequence) return prev;
  const next = reduce(prev, event);
  if (event.sequence === undefined) return next;
  return { ...next, eventSequence: Math.max(event.sequence, next.eventSequence ?? 0) };
}

function reduce(prev: ProjectSnapshot, event: HostEvent): ProjectSnapshot {
  switch (event.type) {
    case 'terminal.state':
      return {
        ...prev,
        terminals: prev.terminals.map((t) => (t.name === event.name ? { ...t, state: event.state, queued: event.queued } : t)),
      };
    case 'terminal.model':
      return { ...prev, terminals: prev.terminals.map((t) => (t.name === event.name ? { ...t, model: event.model } : t)) };
    case 'terminal.added': {
      const exists = prev.terminals.some((t) => t.name === event.info.name);
      return {
        ...prev,
        terminals: exists ? prev.terminals.map((t) => (t.name === event.info.name ? event.info : t)) : [...prev.terminals, event.info],
      };
    }
    case 'terminal.replaced': {
      const from = event.oldName ?? event.info.name;
      if (!prev.terminals.some((t) => t.name === from)) return prev;
      return { ...prev, terminals: prev.terminals.map((t) => (t.name === from ? event.info : t)) };
    }
    case 'terminal.removed':
      return { ...prev, terminals: prev.terminals.filter((t) => t.name !== event.name) };
    case 'terminal.queue':
      return { ...prev, queues: { ...(prev.queues ?? {}), [event.name]: event.entries } };
    default:
      return prev;
  }
}

/** Reaplica, em ordem, os eventos que chegaram enquanto o snapshot era carregado. */
export function replayEvents(snapshot: ProjectSnapshot, events: HostEvent[]): ProjectSnapshot {
  return events.reduce(applyEventToSnapshot, snapshot);
}
