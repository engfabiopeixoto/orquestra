// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import {
  openProject,
  refreshWorkspaces,
  resetWorkspaceRefreshForTest,
  scheduleWorkspaceRefresh,
  shouldRefreshWorkspacesForEvent,
} from '../src/renderer/src/project';
import { workspaceStore } from '../src/renderer/src/workspaces';

describe('refreshWorkspaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkspaceRefreshForTest();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    workspaceStore.setState({ workspaces: [], selectedId: null, changing: false, focusRequest: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('não dispara atualização da store quando workspace.list retorna os mesmos dados', async () => {
    const payload = () => ({
      workspaces: [
        { id: 'w1', dir: 'C:/p1', name: 'p1', status: 'open' as const, terminalCount: 2, busy: 1, waiting: 0 },
      ],
      selectedId: 'w1',
    });
    const command = vi.fn(async () => payload());
    const api = { command } as unknown as CommandApi;

    const notifications = vi.fn();
    const unsub = workspaceStore.subscribe(notifications);

    await refreshWorkspaces(api);
    expect(notifications).toHaveBeenCalledTimes(1);

    await refreshWorkspaces(api);
    await refreshWorkspaces(api);
    expect(notifications).toHaveBeenCalledTimes(1);

    command.mockResolvedValueOnce({
      workspaces: [
        { id: 'w1', dir: 'C:/p1', name: 'p1', status: 'open' as const, terminalCount: 2, busy: 0, waiting: 1 },
      ],
      selectedId: 'w1',
    });
    await refreshWorkspaces(api);
    expect(notifications).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('filtra apenas eventos de ciclo de vida/estado para atualização imediata da lista', () => {
    expect(shouldRefreshWorkspacesForEvent('terminal.state')).toBe(true);
    expect(shouldRefreshWorkspacesForEvent('terminal.added')).toBe(true);
    expect(shouldRefreshWorkspacesForEvent('terminal.removed')).toBe(true);
    expect(shouldRefreshWorkspacesForEvent('workspace.activated')).toBe(true);
    expect(shouldRefreshWorkspacesForEvent('terminal.output')).toBe(false);
    expect(shouldRefreshWorkspacesForEvent('note.changed')).toBe(false);
  });

  it('marca pendência quando evento chega com janela oculta e atualiza ao restaurar a visibilidade', async () => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const command = vi.fn(async () => ({
      workspaces: [{ id: 'w1', dir: 'C:/p1', name: 'p1', status: 'open' as const, terminalCount: 1, busy: 1, waiting: 0 }],
      selectedId: 'w1',
    }));
    const api = { command } as unknown as CommandApi;

    scheduleWorkspaceRefresh(api);
    await vi.advanceTimersByTimeAsync(100);
    expect(command).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(100);
    expect(command).toHaveBeenCalledWith('workspace.list', {});
  });

  it('marca pendência quando evento chega durante changing === true e drena ao concluir a troca', async () => {
    let resolveList!: (value: unknown) => void;
    let listCalls = 0;
    const command = vi.fn(async (method: string) => {
      if (method === 'project.open') {
        return { dir: 'C:/p1', name: 'p1', workspaceId: 'w1', terminals: [], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } };
      }
      if (method === 'workspace.list') {
        listCalls++;
        if (listCalls === 1) return new Promise((resolve) => { resolveList = resolve; });
        return {
          workspaces: [{ id: 'w1', dir: 'C:/p1', name: 'p1', status: 'open' as const, terminalCount: 1, busy: 0, waiting: 0 }],
          selectedId: 'w1',
        };
      }
      return {};
    });
    const api = { command } as unknown as CommandApi;

    const opening = openProject('C:/p1', api);
    await Promise.resolve();
    await Promise.resolve();
    // Evento chega enquanto openProject ainda está em changing === true e workspace.list inicial já está em voo
    scheduleWorkspaceRefresh(api);
    resolveList({
      workspaces: [{ id: 'w1', dir: 'C:/p1', name: 'p1', status: 'open' as const, terminalCount: 0, busy: 0, waiting: 0 }],
      selectedId: 'w1',
    });
    await opening;

    await vi.advanceTimersByTimeAsync(100);
    expect(listCalls).toBe(2);
    expect(workspaceStore.getState().workspaces[0]?.terminalCount).toBe(1);
  });
});
