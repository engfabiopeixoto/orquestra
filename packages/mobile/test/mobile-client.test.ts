import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalInfo } from '@orquestra/shared/host-protocol';
import { sortTerminalsForMobile, terminalStateLabel } from '../src/terminals.js';
import { calculateBackoffMs, RemoteWsClient, type ConnectionStatus, type SocketLike } from '../src/ws-client.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function terminal(partial: Partial<TerminalInfo> & { name: string }): TerminalInfo {
  return {
    agent: 'claude',
    state: 'idle',
    queued: 0,
    cwd: 'C:/proj',
    resume: true,
    args: [],
    regente: false,
    monitor: false,
    ...partial,
  };
}

describe('cliente mobile', () => {
  it('ordena terminais colocando "esperando você" no topo', () => {
    const ordered = sortTerminalsForMobile([
      terminal({ name: 'shell-idle', agent: 'shell', state: 'idle' }),
      terminal({ name: 'claude-bg', agent: 'claude', state: 'background' as never }),
      terminal({ name: 'codex-exited', agent: 'codex', state: 'exited' }),
      terminal({ name: 'agy-busy', agent: 'agy', state: 'busy' }),
      terminal({ name: 'claude-wait-2', state: 'waiting' }),
      terminal({ name: 'claude-wait-1', state: 'waiting' }),
      terminal({ name: 'queued-idle', state: 'idle', queued: 2 }),
    ]);

    expect(ordered.map((t) => t.name)).toEqual([
      'claude-wait-1',
      'claude-wait-2',
      'agy-busy',
      'queued-idle',
      'claude-bg',
      'shell-idle',
      'codex-exited',
    ]);
    expect(terminalStateLabel(terminal({ name: 'claude-bg', state: 'background' as never }))).toBe('Em segundo plano');
  });

  it('calcula backoff exponencial limitado', () => {
    expect(calculateBackoffMs(0, 1000, 10_000)).toBe(1000);
    expect(calculateBackoffMs(1, 1000, 10_000)).toBe(2000);
    expect(calculateBackoffMs(2, 1000, 10_000)).toBe(4000);
    expect(calculateBackoffMs(4, 1000, 10_000)).toBe(10_000);
  });

  it('reconecta automaticamente com backoff após queda inesperada e para quando revogado', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: ConnectionStatus[] = [];

    const client = new RemoteWsClient({
      url: 'ws://127.0.0.1:47820/ws',
      token: 'tok-123',
      baseDelayMs: 500,
      maxDelayMs: 2000,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatus: (s) => statuses.push(s),
    });

    client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'auth', token: 'tok-123' });

    sockets[0]!.receive({
      type: 'auth-ok',
      device: { id: 'd1', name: 'Pixel', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: null },
    });
    expect(statuses.at(-1)).toBe('connected');

    const cmdPromise = client.command('workspace.list', {});
    const sentCmd = JSON.parse(sockets[0]!.sent[1]!);
    expect(sentCmd.method).toBe('workspace.list');
    sockets[0]!.receive({ type: 'response', id: sentCmd.id, ok: true, result: { workspaces: [], selectedId: null } });
    expect(await cmdPromise).toEqual({ workspaces: [], selectedId: null });

    // Queda inesperada agenda reconexão em 500 ms
    sockets[0]!.close(1006, 'dropped');
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);

    // Se o servidor responder auth-error (revogado), não reconecta mais
    sockets[1]!.open();
    sockets[1]!.receive({ type: 'auth-error', error: { code: 'INVALID_TOKEN', message: 'Revogado' } });
    expect(statuses.at(-1)).toBe('revoked');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(2);

    client.close();
  });
});

describe('cliente mobile: validação e reconexão', () => {
  const device = { id: 'd1', name: 'Pixel', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: null };

  function connected() {
    const sockets: FakeSocket[] = [];
    const statuses: ConnectionStatus[] = [];
    const client = new RemoteWsClient({
      url: 'ws://127.0.0.1:47820/ws',
      token: 't',
      baseDelayMs: 100,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStatus: (s) => statuses.push(s),
    });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'auth-ok', device });
    return { client, sockets, statuses };
  }

  it('valida o resultado de cada comando com o schema do protocolo', async () => {
    const { client, sockets } = connected();
    const pending = client.command('workspace.list', {});
    const id = JSON.parse(sockets[0]!.sent[1]!).id;
    sockets[0]!.receive({ type: 'response', id, ok: true, result: { workspaces: 'não é lista' } });
    await expect(pending).rejects.toMatchObject({ code: 'INTERNAL', message: 'Resposta inválida do computador.' });
    client.close();
  });

  it('type "error" (prazo de rede) não revoga: o socket fecha e o cliente reconecta', async () => {
    vi.useFakeTimers();
    const { client, sockets, statuses } = connected();
    sockets[0]!.receive({ type: 'error', error: { code: 'INVALID_TOKEN', message: 'Autenticação não recebida no prazo.' } });
    expect(statuses.at(-1)).toBe('connected');
    sockets[0]!.close(4001, 'Tempo de autenticação esgotado');
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it('subscribe e unsubscribe vão ao servidor e as assinaturas são refeitas depois de reconectar', async () => {
    vi.useFakeTimers();
    const { client, sockets } = connected();
    const sent = (index: number) => sockets[index]!.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'subscribe' || m.type === 'unsubscribe');

    client.subscribe('w1', 'A');
    client.subscribe('w1', 'B');
    client.unsubscribe('w1', 'B');
    expect(sent(0)).toEqual([
      { type: 'subscribe', workspaceId: 'w1', name: 'A' },
      { type: 'subscribe', workspaceId: 'w1', name: 'B' },
      { type: 'unsubscribe', workspaceId: 'w1', name: 'B' },
    ]);

    sockets[0]!.close(1006, 'dropped');
    await vi.advanceTimersByTimeAsync(100);
    sockets[1]!.open();
    expect(sent(1)).toEqual([]);
    sockets[1]!.receive({ type: 'auth-ok', device });
    expect(sent(1)).toEqual([{ type: 'subscribe', workspaceId: 'w1', name: 'A' }]);
    client.close();
  });

  it('assinar sem conexão só registra: a assinatura sai quando autenticar', () => {
    const sockets: FakeSocket[] = [];
    const client = new RemoteWsClient({ url: 'ws://x/ws', token: 't', createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
    client.subscribe('w1', 'A');
    client.connect();
    sockets[0]!.open();
    expect(sockets[0]!.sent.map((r) => JSON.parse(r).type)).toEqual(['auth']);
    sockets[0]!.receive({ type: 'auth-ok', device });
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ type: 'subscribe', workspaceId: 'w1', name: 'A' });
    client.close();
  });

  it('output-overflow chega ao callback e eventos de saída seguem pelo onEvent', () => {
    const sockets: FakeSocket[] = [];
    const overflows: unknown[] = [];
    const events: unknown[] = [];
    const client = new RemoteWsClient({
      url: 'ws://x/ws', token: 't',
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      onOutputOverflow: (o) => overflows.push(o),
      onEvent: (e) => events.push(e),
    });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'auth-ok', device });
    sockets[0]!.receive({ type: 'output-overflow', name: 'A', workspaceId: 'w1' });
    sockets[0]!.receive({ type: 'event', event: { type: 'terminal.output', name: 'A', data: 'x', workspaceId: 'w1' } });
    expect(overflows).toEqual([{ name: 'A', workspaceId: 'w1' }]);
    expect(events).toHaveLength(1);
    client.close();
  });
});
