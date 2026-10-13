import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveWorkspace, outputKey } from '../src/renderer/src/workspace-context';
import { createCommandApi, CommandError } from '../src/renderer/src/api';
import { routeEvent, flushWorkspaceEvents } from '../src/renderer/src/events';
import { workspaceStore } from '../src/renderer/src/workspaces';
import { OutputBus } from '../src/renderer/src/output-bus';
afterEach(() => { setActiveWorkspace(undefined); workspaceStore.setState({ changing: false }); flushWorkspaceEvents({ applyEvent: () => {} }); });

describe('roteamento de eventos', () => {
  it('reaplica somente eventos posteriores ao snapshot durante a troca de aba', () => {
    setActiveWorkspace('origem');
    workspaceStore.setState({ changing: true });
    const bus = new OutputBus();
    const store = { applyEvent: vi.fn() };
    const oldEvent = { type: 'terminal.state' as const, name: 'S', state: 'busy' as const, queued: 0, workspaceId: 'destino', sequence: 1 };
    const newEvent = { ...oldEvent, state: 'idle' as const, sequence: 2 };
    routeEvent(oldEvent, { store, bus }); routeEvent(newEvent, { store, bus });
    expect(store.applyEvent).not.toHaveBeenCalled();
    setActiveWorkspace('destino');
    flushWorkspaceEvents(store, 'destino', 1);
    expect(store.applyEvent.mock.calls).toEqual([[newEvent]]);
  });
  it('ignora eventos de outro workspace e usa saída com identificação composta', () => {
    setActiveWorkspace('A');
    const bus = new OutputBus();
    const seen: string[] = [];
    bus.subscribe(outputKey('S', 'A'), (data) => seen.push(data));
    const store = { applyEvent: vi.fn() };
    routeEvent({ type: 'terminal.output', name: 'S', data: 'errado', workspaceId: 'B' }, { store, bus });
    routeEvent({ type: 'terminal.state', name: 'S', state: 'exited', queued: 0, workspaceId: 'B' }, { store, bus });
    routeEvent({ type: 'terminal.output', name: 'S', data: 'certo', workspaceId: 'A' }, { store, bus });
    expect(seen).toEqual(['certo']);
    expect(store.applyEvent).not.toHaveBeenCalled();
  });
  it('saída vai para o barramento; o resto, para o estado', () => {
    const bus = new OutputBus();
    const seen: string[] = [];
    bus.subscribe('A', (data) => seen.push(data));
    const store = { applyEvent: vi.fn() };
    routeEvent({ type: 'terminal.output', name: 'A', data: 'x' }, { store, bus });
    routeEvent({ type: 'notice', level: 'info', message: 'oi' }, { store, bus });
    expect(seen).toEqual(['x']);
    expect(store.applyEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createCommandApi', () => {
  it('captura o workspace de origem e não aplica resposta atrasada na nova aba', async () => {
    setActiveWorkspace('A');
    let complete!: (value: { ok: true; result: unknown }) => void;
    const invoke = vi.fn(() => new Promise<{ ok: true; result: unknown }>((resolve) => { complete = resolve; }));
    const operation = createCommandApi(invoke).command('note.save', { name: 'nota', content: 'origem', baseRevision: null });
    expect(invoke).toHaveBeenCalledWith('note.save', expect.anything(), 'A');
    setActiveWorkspace('B');
    complete({ ok: true, result: {} });
    await expect(operation).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });
  it('devolve o resultado ou lança CommandError com o código', async () => {
    const api = createCommandApi(async (method) =>
      method === 'project.close' ? { ok: true, result: {} } : { ok: false, error: { code: 'NOT_FOUND', message: 'X não existe.' } },
    );
    await expect(api.command('project.close', {})).resolves.toEqual({});
    await expect(api.command('edge.connect', { a: 'A', b: 'X' })).rejects.toBeInstanceOf(CommandError);
  });
});
