// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, TerminalInfo, WorkspaceInfo } from '@orquestra/shared/host-protocol';
import type { RemoteSnapshot } from '@orquestra/shared/remote-snapshot';
import { App, PairScreen, UsageSection } from '../src/App';
import { RemoteWsClient } from '../src/ws-client';

const fakeView = vi.hoisted(() => ({ load: vi.fn(), write: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/terminal-view', () => ({
  createXtermView: () => fakeView,
  fontSizeForWidth: () => ({ fontSize: 12, scrollsHorizontally: false }),
}));

const device = { id: 'dev-1', name: 'Pixel', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: null };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static handler: (method: string, params: any) => unknown | Promise<unknown> = () => ({});
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly commands: Array<{ method: string; params: any }> = [];
  readonly subscriptions: Array<{ type: string; workspaceId: string; name: string }> = [];
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    const msg = JSON.parse(data);
    if (msg.type === 'auth') return void queueMicrotask(() => this.push({ type: 'auth-ok', device }));
    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') return void this.subscriptions.push(msg);
    this.commands.push({ method: msg.method, params: msg.params });
    void Promise.resolve(FakeWebSocket.handler(msg.method, msg.params)).then((result) => this.push({ type: 'response', id: msg.id, ok: true, result }));
  }
  push(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  event(event: HostEvent) {
    act(() => this.push({ type: 'event', event }));
  }
  close() {
    this.readyState = 3;
  }
}
const lastSocket = () => FakeWebSocket.instances.at(-1)!;

const term = (name: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  name, agent: 'claude', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false, ...extra,
});
const workspace = (id: string, name: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id, dir: `C:/${name}`, name, status: 'open', terminalCount: 2, busy: 0, waiting: 1, ...extra,
});
const snapshot = (id: string, name: string, terminals: TerminalInfo[], eventSequence = 0): RemoteSnapshot => ({ workspaceId: id, name, terminals, eventSequence });

const WORKSPACES = [workspace('w1', 'Alpha'), workspace('w2', 'Beta')];
const SNAPSHOTS: Record<string, RemoteSnapshot> = {
  w1: snapshot('w1', 'Alpha', [term('arquiteto'), term('revisor', { state: 'waiting' })], 5),
  w2: snapshot('w2', 'Beta', [term('solo')], 1),
};

function setupHost(extra?: (method: string, params: any) => unknown) {
  FakeWebSocket.handler = (method, params) => {
    const custom = extra?.(method, params);
    if (custom !== undefined) return custom;
    if (method === 'workspace.list') return { workspaces: WORKSPACES, selectedId: 'w1' };
    if (method === 'workspace.activate') return SNAPSHOTS[params.id];
    if (method === 'terminal.snapshot') return { data: 'retrato', cols: 100, rows: 30 };
    if (method.startsWith('usage.')) return { checkedAt: '2026-11-18T00:00:00Z', windows: [], credits: null, details: [] };
    return {};
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  fakeView.load.mockClear();
  fakeView.write.mockClear();
  fakeView.dispose.mockClear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  setupHost();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function storeAuth() {
  localStorage.setItem('orquestra.mobile.auth', JSON.stringify({ token: 'tok', device }));
}

describe('PairScreen', () => {
  it('mostra o campo de código quando não há ?pair= e envia nome e código ao pareamento', async () => {
    const onPaired = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ deviceToken: 'tok-novo', device }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PairScreen initialToken="" onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pair-token-input'), { target: { value: 'codigo-123' } });
    fireEvent.click(screen.getByTestId('pair-submit'));
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith({ token: 'tok-novo', device }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ pairToken: 'codigo-123', deviceName: 'Celular' });
    expect(JSON.parse(localStorage.getItem('orquestra.mobile.auth')!)).toMatchObject({ token: 'tok-novo' });
  });

  it('com ?pair= esconde o campo; se o QR expirou, mostra o erro e libera o campo para colar um novo código', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Link de pareamento inválido ou expirado.' } }), { status: 401 })));
    render(<PairScreen initialToken="velho" onPaired={vi.fn()} />);
    expect(screen.queryByTestId('pair-token-input')).toBeNull();
    fireEvent.click(screen.getByTestId('pair-submit'));
    expect((await screen.findByTestId('pair-error')).textContent).toBe('Link de pareamento inválido ou expirado.');
    expect(screen.getByTestId('pair-token-input')).toBeTruthy();
  });

  it('resposta que não é JSON (503 em texto puro) vira mensagem em português, nunca SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Build do aplicativo móvel não encontrado.', { status: 503 })));
    render(<PairScreen initialToken="x" onPaired={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pair-submit'));
    const error = (await screen.findByTestId('pair-error')).textContent!;
    expect(error).toContain('HTTP 503');
    expect(error).not.toMatch(/JSON|Unexpected/);
  });
});

describe('App', () => {
  it('remove ?pair= da barra de endereço assim que o código é lido', async () => {
    window.history.replaceState({}, '', '/?pair=segredo123');
    render(<App />);
    await waitFor(() => expect(window.location.search).toBe(''));
    // O código lido continua em memória para o envio, mesmo sem aparecer na barra de endereço.
    expect(screen.getByTestId('pair-submit')).toBeTruthy();
  });

  it('ignora credencial salva com formato inválido e volta ao pareamento', () => {
    localStorage.setItem('orquestra.mobile.auth', JSON.stringify({ token: 'x', device: { id: 5 } }));
    render(<App />);
    expect(screen.getByTestId('pair-submit')).toBeTruthy();
  });

  it('lista os workspaces, abre os agentes e acompanha o estado ao vivo, incluindo ações feitas no PC', async () => {
    storeAuth();
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    expect(await screen.findByTestId('active-workspace-title')).toHaveProperty('textContent', 'Agentes · Alpha');
    const socket = lastSocket();

    // "esperando você" sobe para o topo
    const cards = screen.getAllByTestId(/^agent-card-/).map((el) => el.getAttribute('data-testid'));
    expect(cards).toEqual(['agent-card-revisor', 'agent-card-arquiteto']);

    socket.event({ type: 'terminal.state', name: 'arquiteto', state: 'busy', queued: 0, workspaceId: 'w1', sequence: 6 });
    expect(screen.getByTestId('agent-state-arquiteto').textContent).toBe('Ocupado');

    // Criar no PC aparece no celular; descarregar no PC mostra "Descarregado"; renomear troca o nome do cartão.
    socket.event({ type: 'terminal.added', info: term('novo'), rect: { x: 0, y: 0, width: 1, height: 1 }, connectedTo: null, workspaceId: 'w1', sequence: 7 });
    expect(screen.getByTestId('agent-card-novo')).toBeTruthy();
    socket.event({ type: 'terminal.replaced', info: term('novo', { state: 'exited', unloaded: true }), workspaceId: 'w1', sequence: 8 });
    expect(screen.getByTestId('agent-state-novo').textContent).toBe('Descarregado');
    socket.event({ type: 'terminal.replaced', info: term('renomeado'), oldName: 'novo', workspaceId: 'w1', sequence: 9 });
    expect(screen.queryByTestId('agent-card-novo')).toBeNull();
    expect(screen.getByTestId('agent-card-renomeado')).toBeTruthy();
    socket.event({ type: 'terminal.removed', name: 'renomeado', workspaceId: 'w1', sequence: 10 });
    expect(screen.queryByTestId('agent-card-renomeado')).toBeNull();

    // Evento atrasado (sequence anterior ao snapshot) não reverte o estado.
    socket.event({ type: 'terminal.state', name: 'arquiteto', state: 'idle', queued: 0, workspaceId: 'w1', sequence: 3 });
    expect(screen.getByTestId('agent-state-arquiteto').textContent).toBe('Ocupado');
  });

  it('reaplica por sequence os eventos que chegam enquanto workspace.activate está em voo', async () => {
    storeAuth();
    let release: (() => void) | undefined;
    setupHost((method, params) => {
      if (method === 'workspace.activate') return new Promise((resolve) => { release = () => resolve(SNAPSHOTS[params.id]); });
      return undefined;
    });
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    await waitFor(() => expect(release).toBeDefined());
    const socket = lastSocket();
    socket.event({ type: 'terminal.state', name: 'arquiteto', state: 'busy', queued: 0, workspaceId: 'w1', sequence: 4 });
    socket.event({ type: 'terminal.state', name: 'arquiteto', state: 'waiting', queued: 0, workspaceId: 'w1', sequence: 6 });
    await act(async () => release!());
    expect((await screen.findByTestId('agent-state-arquiteto')).textContent).toBe('Esperando você');
  });

  it('evento que chega entre a resposta de workspace.activate e o re-render não é descartado', async () => {
    storeAuth();
    let release: (() => void) | undefined;
    setupHost((method, params) => {
      if (method === 'workspace.activate') return new Promise((resolve) => { release = () => resolve(SNAPSHOTS[params.id]); });
      return undefined;
    });
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    await waitFor(() => expect(release).toBeDefined());
    const socket = lastSocket();
    await act(async () => {
      release!();
      // A continuação de openWorkspace já rodou, mas o React ainda não renderizou (tudo dentro do mesmo act).
      for (let i = 0; i < 20; i++) await Promise.resolve();
      socket.push({ type: 'event', event: { type: 'terminal.state', name: 'arquiteto', state: 'busy', queued: 0, workspaceId: 'w1', sequence: 7 } });
    });
    expect((await screen.findByTestId('agent-state-arquiteto')).textContent).toBe('Ocupado');
  });

  it('toca no agente para abrir o terminal: assina a saída, mostra o retrato e a saída ao vivo; overflow pede snapshot novo; voltar cancela a assinatura', async () => {
    storeAuth();
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    fireEvent.click(await screen.findByTestId('agent-card-revisor'));
    expect(await screen.findByTestId('terminal-screen')).toBeTruthy();
    const socket = lastSocket();
    await waitFor(() => expect(fakeView.load).toHaveBeenCalledWith('retrato', 100, 30, expect.any(Number)));
    expect(socket.subscriptions).toContainEqual({ type: 'subscribe', workspaceId: 'w1', name: 'revisor' });
    expect(screen.getByTestId('terminal-state').textContent).toBe('Esperando você');

    socket.event({ type: 'terminal.output', name: 'revisor', data: 'olá do agente', workspaceId: 'w1', sequence: 20 });
    expect(fakeView.write).toHaveBeenCalledWith('olá do agente');
    socket.event({ type: 'terminal.output', name: 'revisor', data: 'de outro workspace', workspaceId: 'w2' });
    expect(fakeView.write).not.toHaveBeenCalledWith('de outro workspace');

    act(() => socket.push({ type: 'output-overflow', name: 'revisor', workspaceId: 'w1' }));
    await waitFor(() => expect(socket.commands.filter((c) => c.method === 'terminal.snapshot')).toHaveLength(2));

    // O estado do cartão continua ao vivo dentro da tela do terminal.
    socket.event({ type: 'terminal.state', name: 'revisor', state: 'busy', queued: 0, workspaceId: 'w1', sequence: 21 });
    expect(screen.getByTestId('terminal-state').textContent).toBe('Ocupado');

    fireEvent.click(screen.getByTestId('terminal-back'));
    expect(await screen.findByTestId('active-workspace-title')).toBeTruthy();
    expect(socket.subscriptions).toContainEqual({ type: 'unsubscribe', workspaceId: 'w1', name: 'revisor' });
  });

  it('terminal removido no PC fecha a tela do terminal', async () => {
    storeAuth();
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    fireEvent.click(await screen.findByTestId('agent-card-revisor'));
    await screen.findByTestId('terminal-screen');
    lastSocket().event({ type: 'terminal.removed', name: 'revisor', workspaceId: 'w1', sequence: 30 });
    expect(await screen.findByTestId('active-workspace-title')).toBeTruthy();
  });

  it('quando o PC ativa outro workspace, o celular que vê os agentes acompanha; na lista só atualiza o destaque', async () => {
    storeAuth();
    render(<App />);
    fireEvent.click(await screen.findByTestId('workspace-card-w1'));
    await screen.findByTestId('active-workspace-title');
    const socket = lastSocket();

    socket.event({ type: 'workspace.activated', workspaceId: 'w2' });
    await waitFor(() => expect(screen.getByTestId('active-workspace-title').textContent).toBe('Agentes · Beta'));
    expect(socket.commands.filter((c) => c.method === 'workspace.activate').map((c) => c.params.id)).toEqual(['w1', 'w2']);

    // Evento da própria ativação (mesmo id já exibido) não recarrega.
    socket.event({ type: 'workspace.activated', workspaceId: 'w2' });
    expect(socket.commands.filter((c) => c.method === 'workspace.activate')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('mobile-back-workspaces'));
    await screen.findByTestId('workspace-card-w1');
    socket.event({ type: 'workspace.activated', workspaceId: 'w1' });
    expect(socket.commands.filter((c) => c.method === 'workspace.activate')).toHaveLength(2);
  });

  it('mostra a tela de revogação e permite parear de novo', async () => {
    storeAuth();
    render(<App />);
    await screen.findByTestId('workspace-card-w1');
    act(() => lastSocket().push({ type: 'auth-error', error: { code: 'INVALID_TOKEN', message: 'Dispositivo revogado.' } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Dispositivo revogado.');
    fireEvent.click(screen.getByText('Parear novamente'));
    expect(localStorage.getItem('orquestra.mobile.auth')).toBeNull();
    expect(screen.getByTestId('pair-submit')).toBeTruthy();
  });
});

describe('UsageSection', () => {
  it('mostra janelas com renovação, créditos e detalhes das assinaturas', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString();
    const client = new RemoteWsClient({ url: 'ws://x/ws', token: 't', createSocket: () => { throw new Error('não usar'); } });
    vi.spyOn(client, 'command').mockImplementation((async (method: string) => {
      if (method === 'usage.codex') return { checkedAt: 'x', windows: [{ label: '5h', usedPercent: 42, resetsAt }], credits: 'US$ 12,30', details: [{ label: 'Plano', value: 'Pro' }] };
      if (method === 'usage.claude') return { checkedAt: 'x', windows: [{ label: '7 dias', usedPercent: 95, resetsAt: null }], credits: null, details: [] };
      throw new Error('Indisponível.');
    }) as never);
    render(<UsageSection client={client} />);
    expect(await screen.findByText('sessão 5h')).toBeTruthy();
    expect(screen.getByText(/42% usado · renova em 2h/)).toBeTruthy();
    expect(screen.getByTestId('usage-credits-codex').textContent).toContain('US$ 12,30');
    expect(screen.getByText('Plano')).toBeTruthy();
    expect(screen.getByText('semanal')).toBeTruthy();
    expect(screen.getByText('95% usado')).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText('Uso das assinaturas')).getAllByText('Consultar')[0]!);
    expect(await screen.findByText('Indisponível.')).toBeTruthy();
  });
});
