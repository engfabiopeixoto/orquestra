import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type { Logger } from '@orquestra/core';
import {
  isHostMethod,
  isRemoteAllowedMethod,
  OrqError,
  parseHostParams,
  REMOTE_MAX_MESSAGE_BYTES,
  REMOTE_MAX_SUBSCRIPTIONS,
  remoteClientMessageSchema,
  type RemoteClientMessage,
  type RemoteServerMessage,
} from '@orquestra/shared';
import type { HostBridge } from '../../bridge.js';
import type { RemoteDeviceStore } from '../device-store.js';
import type { ClientConn, OutputBufferController, PendingCommand } from './types.js';

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

/** Envia uma mensagem JSON pela conexão WebSocket se ela ainda estiver aberta. */
export function sendWs(ws: WebSocket, message: RemoteServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export type WsSessionManagerDeps = {
  store: RemoteDeviceStore;
  log: Logger;
  authTimeoutMs: number;
  outputBuffer: OutputBufferController;
  isEnabled: () => boolean;
  getBridge: () => HostBridge | null;
};

export type WsSessionManager = {
  handleWsConnection: (ws: WebSocket) => void;
  revokeConnectionsForDevice: (deviceId: string) => void;
  closeAllClients: () => void;
  takePending: (internalId: string) => PendingCommand | undefined;
  getClient: (connId: string) => ClientConn | undefined;
  forEachClient: (fn: (conn: ClientConn) => void) => void;
  forEachAuthedClient: (fn: (conn: ClientConn) => void) => void;
};

/** Gerencia conexões WebSocket, autenticação, assinaturas e despacho de comandos remotos. */
export function createWsSessionManager(deps: WsSessionManagerDeps): WsSessionManager {
  const clients = new Map<string, ClientConn>();
  const pending = new Map<string, PendingCommand>();

  function clearPendingFor(connId: string): void {
    for (const [internalId, entry] of pending) {
      if (entry.connId === connId) pending.delete(internalId);
    }
  }

  function cleanupConnection(conn: ClientConn): void {
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    conn.device = null;
    deps.outputBuffer.clearOutput(conn);
    clients.delete(conn.id);
    clearPendingFor(conn.id);
  }

  function decodeClientMessage(conn: ClientConn, raw: RawData): RemoteClientMessage | null {
    const buf = rawDataToBuffer(raw);
    if (buf.length > REMOTE_MAX_MESSAGE_BYTES) {
      sendWs(conn.ws, { type: 'error', error: { code: 'USAGE', message: 'Mensagem excede 64 KB.' } });
      conn.ws.close(1009, 'Mensagem excede 64 KB');
      return null;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(buf.toString('utf8'));
    } catch {
      sendWs(conn.ws, { type: 'error', error: { code: 'USAGE', message: 'JSON inválido.' } });
      if (!conn.device) conn.ws.close(4001, 'Mensagem inicial inválida');
      return null;
    }

    const parsed = remoteClientMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      sendWs(conn.ws, { type: 'error', error: { code: 'USAGE', message: 'Formato de mensagem inválido.' } });
      if (!conn.device) conn.ws.close(4001, 'Mensagem inicial inválida');
      return null;
    }
    return parsed.data;
  }

  function authenticateConn(conn: ClientConn, msg: RemoteClientMessage): void {
    if (msg.type !== 'auth') {
      sendWs(conn.ws, {
        type: 'auth-error',
        error: { code: 'INVALID_TOKEN', message: 'Autenticação obrigatória na primeira mensagem.' },
      });
      conn.ws.close(4001, 'Autenticação obrigatória');
      return;
    }
    const device = deps.store.authenticate(msg.token);
    if (!device) {
      sendWs(conn.ws, {
        type: 'auth-error',
        error: { code: 'INVALID_TOKEN', message: 'Token de dispositivo inválido ou revogado.' },
      });
      conn.ws.close(4003, 'Token inválido');
      return;
    }
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    conn.device = device;
    deps.log.info({ deviceId: device.id, deviceName: device.name }, 'cliente remoto autenticado');
    sendWs(conn.ws, { type: 'auth-ok', device });
  }

  async function dispatchRemoteCommand(
    conn: ClientConn,
    cmd: { id: string; method: string; params?: unknown; workspaceId?: string },
  ): Promise<void> {
    const device = conn.device;
    if (!device || !deps.isEnabled() || !clients.has(conn.id)) return;

    if (!isRemoteAllowedMethod(cmd.method) || !isHostMethod(cmd.method)) {
      deps.log.warn({ deviceId: device.id, deviceName: device.name, method: cmd.method }, 'comando remoto recusado');
      sendWs(conn.ws, {
        type: 'response-error',
        id: cmd.id,
        error: { code: 'UNSUPPORTED', message: `Método não permitido no controle remoto: ${cmd.method}.` },
      });
      return;
    }

    let validatedParams: unknown;
    try {
      validatedParams = parseHostParams(cmd.method, cmd.params);
    } catch (error) {
      const orq = error instanceof OrqError ? error : new OrqError('USAGE', 'Parâmetros inválidos.');
      sendWs(conn.ws, {
        type: 'response-error',
        id: cmd.id,
        error: { code: orq.code, message: orq.message },
      });
      return;
    }

    const terminalName =
      validatedParams && typeof validatedParams === 'object' && 'name' in validatedParams && typeof (validatedParams as { name?: unknown }).name === 'string'
        ? (validatedParams as { name: string }).name
        : undefined;

    // Auditoria registra dispositivo, método e terminal alvo — nunca registra o texto digitado.
    deps.log.info(
      { deviceId: device.id, deviceName: device.name, method: cmd.method, ...(terminalName ? { terminal: terminalName } : {}) },
      'comando remoto autorizado',
    );

    const bridge = deps.getBridge();
    if (!bridge) {
      sendWs(conn.ws, {
        type: 'response-error',
        id: cmd.id,
        error: { code: 'APP_UNAVAILABLE', message: 'Núcleo indisponível.' },
      });
      return;
    }

    const internalId = `remote:${conn.id}:${randomUUID()}`;
    pending.set(internalId, { connId: conn.id, clientCmdId: cmd.id, method: cmd.method, terminal: terminalName });
    try {
      await bridge.handle({
        kind: 'command',
        id: internalId,
        method: cmd.method,
        params: validatedParams,
        workspaceId: cmd.workspaceId,
      });
    } catch (error) {
      if (pending.delete(internalId)) {
        const orq = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do Orquestra.');
        sendWs(conn.ws, {
          type: 'response-error',
          id: cmd.id,
          error: { code: orq.code, message: orq.message },
        });
      }
    }
  }

  function handleAuthedMessage(conn: ClientConn, msg: RemoteClientMessage): void {
    if (msg.type === 'subscribe') {
      const key = `${msg.workspaceId}:${msg.name}`;
      if (!conn.subscriptions.has(key) && conn.subscriptions.size >= REMOTE_MAX_SUBSCRIPTIONS) {
        sendWs(conn.ws, { type: 'error', error: { code: 'USAGE', message: 'Assinaturas demais nesta conexão.' } });
        return;
      }
      conn.subscriptions.add(key);
      return;
    }
    if (msg.type === 'unsubscribe') {
      conn.subscriptions.delete(`${msg.workspaceId}:${msg.name}`);
      for (const [key, entry] of conn.output) {
        if (entry.name === msg.name && key.startsWith(`${msg.workspaceId}:`)) conn.output.delete(key);
      }
      deps.outputBuffer.recomputeOutputBytes(conn);
      conn.overflowed.delete(msg.name);
      return;
    }
    if (msg.type !== 'command') {
      sendWs(conn.ws, { type: 'error', error: { code: 'USAGE', message: 'Cliente já autenticado.' } });
      return;
    }
    void dispatchRemoteCommand(conn, msg);
  }

  function handleWsConnection(ws: WebSocket): void {
    const connId = randomUUID();
    const conn: ClientConn = {
      id: connId,
      ws,
      device: null,
      subscriptions: new Set(),
      output: new Map(),
      outputBytes: 0,
      outputTimer: null,
      overflowed: new Set(),
      authTimer: setTimeout(() => {
        if (!conn.device) {
          clients.delete(connId);
          // Usa type: 'error' no timeout de rede para o cliente tentar reconectar com backoff.
          sendWs(ws, {
            type: 'error',
            error: { code: 'INVALID_TOKEN', message: 'Autenticação não recebida no prazo de 5 segundos.' },
          });
          ws.close(4001, 'Tempo de autenticação esgotado');
        }
      }, deps.authTimeoutMs),
    };
    clients.set(connId, conn);

    ws.on('error', (error) => {
      deps.log.warn({ connId, err: error.message }, 'erro na conexão WebSocket remota');
    });

    ws.on('close', () => cleanupConnection(conn));

    ws.on('message', (raw) => {
      if (!deps.isEnabled() || !clients.has(connId) || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const msg = decodeClientMessage(conn, raw);
      if (!msg) return;
      if (!conn.device) return authenticateConn(conn, msg);
      handleAuthedMessage(conn, msg);
    });
  }

  function revokeConnectionsForDevice(deviceId: string): void {
    for (const conn of [...clients.values()]) {
      if (conn.device?.id === deviceId) {
        cleanupConnection(conn);
        sendWs(conn.ws, {
          type: 'auth-error',
          error: { code: 'INVALID_TOKEN', message: 'Dispositivo revogado.' },
        });
        conn.ws.close(4003, 'Dispositivo revogado');
        setTimeout(() => {
          try { conn.ws.terminate(); } catch {}
        }, 1000).unref();
      }
    }
  }

  function closeAllClients(): void {
    for (const conn of [...clients.values()]) {
      cleanupConnection(conn);
      try { conn.ws.close(1000, 'Acesso remoto desligado'); } catch {}
      try { conn.ws.terminate(); } catch {}
    }
    pending.clear();
  }

  return {
    handleWsConnection,
    revokeConnectionsForDevice,
    closeAllClients,
    takePending: (internalId) => {
      const entry = pending.get(internalId);
      if (entry) pending.delete(internalId);
      return entry;
    },
    getClient: (connId) => clients.get(connId),
    forEachClient: (fn) => {
      for (const conn of clients.values()) fn(conn);
    },
    forEachAuthedClient: (fn) => {
      for (const conn of clients.values()) {
        if (conn.device) fn(conn);
      }
    },
  };
}
