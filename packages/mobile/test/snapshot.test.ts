import { describe, expect, it } from 'vitest';
import type { HostEvent, ProjectSnapshot, TerminalInfo } from '@orquestra/shared/host-protocol';
import { applyEventToSnapshot, replayEvents } from '../src/snapshot.js';

const term = (name: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  name, agent: 'claude', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false, ...extra,
});
const snapshot = (terminals: TerminalInfo[], eventSequence?: number): ProjectSnapshot => ({
  workspaceId: 'w1', dir: 'C:/p', name: 'p', terminals, notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 }, eventSequence,
});
const state = (name: string, s: TerminalInfo['state'], sequence?: number): HostEvent => ({ type: 'terminal.state', name, state: s, queued: 0, workspaceId: 'w1', sequence });

describe('snapshot do celular', () => {
  it('ignora eventos já refletidos no snapshot (sequence <= eventSequence)', () => {
    const base = snapshot([term('A')], 10);
    expect(applyEventToSnapshot(base, state('A', 'busy', 10))).toBe(base);
    expect(applyEventToSnapshot(base, state('A', 'busy', 9))).toBe(base);
    const next = applyEventToSnapshot(base, state('A', 'waiting', 11));
    expect(next.terminals[0]).toMatchObject({ state: 'waiting' });
    expect(next.eventSequence).toBe(11);
  });

  it('reaplica em ordem os eventos que chegaram durante a ativação', () => {
    const result = replayEvents(snapshot([term('A')], 5), [state('A', 'busy', 4), state('A', 'waiting', 6), state('A', 'idle', 7)]);
    expect(result.terminals[0]).toMatchObject({ state: 'idle' });
    expect(result.eventSequence).toBe(7);
  });

  it('terminal.added é idempotente e terminal.replaced acompanha renomeação e descarregamento', () => {
    let snap = snapshot([term('A')]);
    const added: HostEvent = { type: 'terminal.added', info: term('B'), rect: { x: 0, y: 0, width: 10, height: 10 }, connectedTo: null };
    snap = applyEventToSnapshot(applyEventToSnapshot(snap, added), added);
    expect(snap.terminals.map((t) => t.name)).toEqual(['A', 'B']);
    snap = applyEventToSnapshot(snap, { type: 'terminal.replaced', info: term('C'), oldName: 'B' });
    expect(snap.terminals.map((t) => t.name)).toEqual(['A', 'C']);
    snap = applyEventToSnapshot(snap, { type: 'terminal.replaced', info: term('C', { state: 'exited', unloaded: true }) });
    expect(snap.terminals[1]).toMatchObject({ unloaded: true });
    snap = applyEventToSnapshot(snap, { type: 'terminal.removed', name: 'C' });
    expect(snap.terminals.map((t) => t.name)).toEqual(['A']);
  });

  it('eventos fora da allowlist de efeitos não alteram o snapshot', () => {
    const base = snapshot([term('A')]);
    expect(applyEventToSnapshot(base, { type: 'notice', level: 'info', message: 'x' })).toBe(base);
  });
});
