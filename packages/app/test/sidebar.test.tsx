// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { Sidebar } from '../src/renderer/src/canvas/Sidebar';
import { startupProject } from '../src/renderer/src/project';
import { appStore } from '../src/renderer/src/store';

const projects = [
  { dir: 'C:\\proj\\alfa', name: 'alfa', openedAt: '2026-10-10T10:00:00Z' },
  { dir: 'C:\\proj\\beta', name: 'beta', openedAt: '2026-10-10T09:00:00Z' },
];

function fakeApi() {
  const calls: Array<[string, unknown]> = [];
  const api = {
    command: (async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'recent.list') return { projects };
      if (method === 'workspace.list') return { workspaces: [], selectedId: null };
      if (method === 'files.list') return { entries: [], comparison: 'session', truncated: false };
      if (method === 'project.open') {
        const dir = (params as { dir: string }).dir;
        return { dir, name: dir.split('\\').at(-1), terminals: [], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } };
      }
      return {};
    }) as CommandApi['command'],
  };
  return { api, calls };
}

afterEach(cleanup);
beforeEach(() => appStore.getState().setProject(null));

describe('Sidebar', () => {
  it('lista os recentes e filtra por nome ou caminho', async () => {
    const { api } = fakeApi();
    render(<Sidebar api={api} onOpenSettings={() => {}} onOpenPersonas={() => {}} />);
    await screen.findByTestId('recent-alfa');
    fireEvent.change(screen.getByTestId('recent-filter'), { target: { value: 'BET' } });
    expect(screen.queryByTestId('recent-alfa')).toBeNull();
    expect(screen.getByTestId('recent-beta')).toBeTruthy();
  });

  it('trocar de projeto mantém os terminais anteriores sem pedir confirmação de encerramento', async () => {
    const { api, calls } = fakeApi();
    appStore.getState().loadProject({
      dir: 'C:\\proj\\alfa', name: 'alfa', notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 },
      terminals: [{ name: 'A', agent: 'shell', state: 'idle', queued: 0, cwd: 'C:\\proj\\alfa', resume: true, args: [], regente: false, monitor: false }],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Sidebar api={api} onOpenSettings={() => {}} onOpenPersonas={() => {}} />);
    fireEvent.click(await screen.findByTestId('recent-beta'));
    await waitFor(() => expect(appStore.getState().project?.name).toBe('beta'));
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some(([method]) => method === 'project.open')).toBe(true);
    confirm.mockRestore();
  });

  it('abre diálogo de funções ao clicar no botão Funções', async () => {
    const { api } = fakeApi();
    const onOpenPersonas = vi.fn();
    render(<Sidebar api={api} onOpenSettings={() => {}} onOpenPersonas={onOpenPersonas} />);
    fireEvent.click(await screen.findByTestId('open-personas'));
    expect(onOpenPersonas).toHaveBeenCalled();
  });
});

describe('startupProject', () => {
  it('projeto de teste tem prioridade; senão, o mais recente; sem nada, null', () => {
    expect(startupProject(projects, 'C:\\teste')).toBe('C:\\teste');
    expect(startupProject(projects, null)).toBe('C:\\proj\\alfa');
    expect(startupProject([], null)).toBeNull();
  });
});
