// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import type { CommandApi } from '../src/renderer/src/api';
import { Sidebar } from '../src/renderer/src/canvas/Sidebar';
import { activateWorkspace, closeWorkspace, openProject, startupProject } from '../src/renderer/src/project';
import { appStore } from '../src/renderer/src/store';
import { workspaceStore } from '../src/renderer/src/workspaces';

// openProject continua real (o teste de troca de projeto depende dele); ativar e fechar viram espiões.
vi.mock('../src/renderer/src/project', async (importActual) => {
  const actual = await importActual<typeof import('../src/renderer/src/project')>();
  return { ...actual, openProject: vi.fn(actual.openProject), activateWorkspace: vi.fn(async () => {}), closeWorkspace: vi.fn(async () => {}) };
});

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
beforeEach(() => {
  appStore.getState().setProject(null);
  workspaceStore.setState({ workspaces: [], selectedId: null, changing: false });
  vi.mocked(openProject).mockClear();
  vi.mocked(activateWorkspace).mockClear();
  vi.mocked(closeWorkspace).mockClear();
});

const info = (overrides: Partial<WorkspaceInfo>): WorkspaceInfo => ({ id: 'w1', dir: 'C:\\proj\\alfa', name: 'alfa', status: 'open', terminalCount: 0, busy: 0, waiting: 0, ...overrides });
const renderSidebar = () => {
  const { api } = fakeApi();
  render(<Sidebar api={api} onOpenSettings={() => {}} onOpenPersonas={() => {}} />);
};

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

describe('Sidebar: workspaces', () => {
  it('mostra o status do workspace aberto na linha do projeto e marca o selecionado', async () => {
    workspaceStore.setState({ workspaces: [info({ terminalCount: 5, busy: 2, waiting: 1 })], selectedId: 'w1' });
    renderSidebar();
    const row = await screen.findByTestId('workspace-alfa');
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.className).toContain('is-on');
    expect(row.textContent).toContain('5 agentes · 2 ativos · 1 aguardando');
    expect(row.querySelector('.workspace-dot')?.className).toContain('waiting');
    expect(screen.queryByTestId('recent-alfa')).toBeNull();
    expect(screen.getByTestId('recent-beta').textContent).toBe('beta');
  });

  it('o × fecha o workspace pela id e só existe para workspaces abertos', async () => {
    workspaceStore.setState({ workspaces: [info({})], selectedId: 'w1' });
    renderSidebar();
    await screen.findByTestId('workspace-alfa');
    expect(screen.queryByRole('button', { name: 'Fechar workspace beta' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar workspace alfa' }));
    expect(closeWorkspace).toHaveBeenCalledWith('w1');
  });

  it('clicar em workspace aberto o ativa; em projeto fechado, abre a pasta', async () => {
    workspaceStore.setState({ workspaces: [info({ id: 'w1' }), info({ id: 'w2', dir: 'C:\\proj\\beta', name: 'beta' })], selectedId: 'w1' });
    renderSidebar();
    fireEvent.click(await screen.findByTestId('workspace-beta'));
    expect(activateWorkspace).toHaveBeenCalledWith('w2', expect.anything());
    expect(openProject).not.toHaveBeenCalled();
  });

  it('abre a pasta quando o projeto não tem workspace', async () => {
    workspaceStore.setState({ workspaces: [info({})], selectedId: 'w1' });
    renderSidebar();
    fireEvent.click(await screen.findByTestId('recent-beta'));
    expect(openProject).toHaveBeenCalledWith('C:\\proj\\beta', expect.anything());
    expect(activateWorkspace).not.toHaveBeenCalled();
  });

  it('casa o workspace com o recente sem diferenciar maiúsculas do caminho', async () => {
    workspaceStore.setState({ workspaces: [info({ dir: 'c:\\PROJ\\Alfa' })], selectedId: 'w1' });
    renderSidebar();
    await screen.findByTestId('workspace-alfa');
    expect(screen.queryByTestId('recent-alfa')).toBeNull();
  });

  it('mostra o contador n/3 ao lado de PROJETOS', async () => {
    workspaceStore.setState({ workspaces: [info({ id: 'w1' }), info({ id: 'w2', dir: 'C:\\proj\\beta', name: 'beta' })], selectedId: 'w1' });
    renderSidebar();
    const count = await screen.findByTitle('Máximo de três workspaces simultâneos');
    expect(count.textContent).toBe('2/3');
  });

  it('lista no topo o workspace aberto que não está nos recentes', async () => {
    workspaceStore.setState({ workspaces: [info({ id: 'w9', dir: 'C:\\proj\\gama', name: 'gama', status: 'paused', terminalCount: 3 })], selectedId: null });
    renderSidebar();
    const first = (await screen.findAllByRole('tab'))[0]!;
    expect(first.getAttribute('data-testid')).toBe('workspace-gama');
    expect(first.textContent).toContain('pausado');
    expect(first.getAttribute('aria-selected')).toBe('false');
  });
});

describe('Sidebar: menu do Orquestra', () => {
  const appAction = vi.fn();
  beforeEach(() => { appAction.mockReset(); Object.assign(window, { orquestra: { appAction } }); });

  it.each([
    ['Abrir pasta de logs', 'open-logs'],
    ['Recarregar interface', 'reload'],
    ['Ferramentas do desenvolvedor', 'devtools'],
    ['Sair', 'quit'],
  ])('o item "%s" envia %s e fecha o menu', async (label, action) => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Menu do Orquestra' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(appAction).toHaveBeenCalledWith(action);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('fecha com Escape e com clique fora, sem disparar ação', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Menu do Orquestra' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu do Orquestra' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(appAction).not.toHaveBeenCalled();
  });
});

describe('startupProject', () => {
  it('projeto de teste tem prioridade; senão, o mais recente; sem nada, null', () => {
    expect(startupProject(projects, 'C:\\teste')).toBe('C:\\teste');
    expect(startupProject(projects, null)).toBe('C:\\proj\\alfa');
    expect(startupProject([], null)).toBeNull();
  });
});
