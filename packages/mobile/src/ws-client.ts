import { OrqError } from '@orquestra/shared/errors';
import { parseHostResult, remoteServerMessageSchema, type HostEvent, type HostMethod, type HostParams, type HostResult } from '@orquestra/shared/host-protocol';
import { remoteResultOverrides } from '@orquestra/shared/remote-snapshot';
import type { ZodTypeAny, z } from 'zod';
import type { RemoteDevice } from '@orquestra/shared/remote';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'revoked' | 'closed';

export type SocketLike = {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RemoteWsClientOptions = {
  url: string;
  token: string;
  createSocket?: (url: string) => SocketLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  commandTimeoutMs?: number;
  onStatus?: (status: ConnectionStatus, device?: RemoteDevice, reason?: string) => void;
  onEvent?: (event: HostEvent) => void;
  onOutputOverflow?: (overflow: { name: string; workspaceId?: string }) => void;
};

/** Resultado de um comando como o celular o recebe (workspace.activate e workspace.list são reduzidos pelo gateway). */
export type RemoteResult<M extends HostMethod> = M extends keyof typeof remoteResultOverrides
  ? z.infer<(typeof remoteResultOverrides)[M]>
  : HostResult<M>;

function parseRemoteResult<M extends HostMethod>(method: M, value: unknown): RemoteResult<M> {
  const override = (remoteResultOverrides as Record<string, ZodTypeAny>)[method];
  return (override ? override.parse(value) : parseHostResult(method, value)) as RemoteResult<M>;
}

const WS_OPEN = 1;

export function calculateBackoffMs(attempt: number, baseDelayMs = 1000, maxDelayMs = 30_000): number {
  const exp = Math.min(attempt, 10);
  return Math.min(baseDelayMs * 2 ** exp, maxDelayMs);
}

export class RemoteWsClient {
  private ws: SocketLike | null = null;
  private status: ConnectionStatus = 'connecting';
  private closedManually = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly subscriptions = new Map<string, { workspaceId: string; name: string }>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly opts: RemoteWsClientOptions) {}

  connect(): void {
    this.closedManually = false;
    this.openSocket();
  }

  private setStatus(status: ConnectionStatus, device?: RemoteDevice, reason?: string): void {
    this.status = status;
    this.opts.onStatus?.(status, device, reason);
  }

  private openSocket(): void {
    if (this.closedManually) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const createSocket = this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    const ws = createSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.closedManually) return;
      ws.send(JSON.stringify({ type: 'auth', token: this.opts.token }));
    };

    ws.onmessage = (rawEvent) => {
      if (this.ws !== ws) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(rawEvent.data));
      } catch {
        return;
      }
      const parsed = remoteServerMessageSchema.safeParse(decoded);
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === 'auth-ok') {
        this.attempt = 0;
        this.setStatus('connected', msg.device);
        // Depois de reconectar o servidor não guarda nada: reassina o que a tela aberta precisa.
        for (const sub of this.subscriptions.values()) this.sendSubscription('subscribe', sub.workspaceId, sub.name);
        return;
      }

      if (msg.type === 'auth-error') {
        this.closedManually = true;
        this.rejectAllPending(new OrqError(msg.error.code, msg.error.message));
        this.setStatus('revoked', undefined, msg.error.message);
        try {
          ws.close();
        } catch {}
        return;
      }

      if (msg.type === 'response' || msg.type === 'response-error') {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.type === 'response') entry.resolve(msg.result);
        else entry.reject(new OrqError(msg.error.code, msg.error.message));
        return;
      }

      if (msg.type === 'event') {
        this.opts.onEvent?.(msg.event);
        return;
      }

      if (msg.type === 'output-overflow') {
        this.opts.onOutputOverflow?.({ name: msg.name, workspaceId: msg.workspaceId });
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.rejectAllPending(new OrqError('NOT_CONNECTED', 'Conexão perdida com o computador.'));
      if (this.closedManually || this.status === 'revoked') return;
      const delay = calculateBackoffMs(this.attempt, this.opts.baseDelayMs, this.opts.maxDelayMs);
      this.attempt++;
      this.setStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, delay);
    };

    ws.onerror = () => {
      // onclose trata a reconexão com backoff.
    };
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private sendSubscription(type: 'subscribe' | 'unsubscribe', workspaceId: string, name: string): void {
    if (this.ws && this.ws.readyState === WS_OPEN && this.status === 'connected') {
      this.ws.send(JSON.stringify({ type, workspaceId, name }));
    }
  }

  /** Pede a saída ao vivo de um terminal; vale também depois de reconectar. */
  subscribe(workspaceId: string, name: string): void {
    this.subscriptions.set(`${workspaceId}:${name}`, { workspaceId, name });
    this.sendSubscription('subscribe', workspaceId, name);
  }

  unsubscribe(workspaceId: string, name: string): void {
    this.subscriptions.delete(`${workspaceId}:${name}`);
    this.sendSubscription('unsubscribe', workspaceId, name);
  }

  command<M extends HostMethod>(method: M, params: HostParams<M>, workspaceId?: string): Promise<RemoteResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || this.status !== 'connected') {
      return Promise.reject(new OrqError('NOT_CONNECTED', 'Sem conexão ativa com o computador.'));
    }
    const id = `m-${this.nextId++}`;
    return new Promise<RemoteResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OrqError('APP_UNAVAILABLE', 'Tempo esgotado aguardando resposta do computador.'));
      }, this.opts.commandTimeoutMs ?? 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          try {
            resolve(parseRemoteResult(method, value));
          } catch {
            reject(new OrqError('INTERNAL', 'Resposta inválida do computador.'));
          }
        },
        reject,
        timer,
      });
      ws.send(JSON.stringify({ type: 'command', id, method, params, workspaceId }));
    });
  }

  close(): void {
    this.closedManually = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new OrqError('NOT_CONNECTED', 'Cliente encerrado.'));
    if (this.ws) {
      try {
        this.ws.close(1000, 'Desconectado');
      } catch {}
      this.ws = null;
    }
    this.setStatus('closed');
  }
}
