import type { Logger } from '@orquestra/core';
import {
  isRemoteAllowedEvent,
  OrqError,
  parseHostParams,
  toRemoteSnapshot,
  toRemoteWorkspaceList,
  type HostToMain,
  type MainToHost,
  type RemoteDevice,
  type RemotePairResult,
  type RemoteStatus,
} from '@orquestra/shared';
import type { HostBridge } from '../../bridge.js';
import type { ClientConn, OutputBufferController, PendingCommand, SendWs } from './types.js';
import type { WsSessionManager } from './ws-session.js';

export type AdminCommandTarget = {
  status: () => RemoteStatus;
  enable: (enabled: boolean, opts?: { fallbackHttp?: boolean }) => Promise<RemoteStatus>;
  pair: () => RemotePairResult;
  devices: () => { devices: RemoteDevice[] };
  revoke: (id: string) => void;
};

export type HostRelayDeps = {
  log: Logger;
  electronSend: (message: HostToMain) => void;
  wsSessions: WsSessionManager;
  outputBuffer: OutputBufferController;
  sendWs: SendWs;
  attachBridge: (bridge: HostBridge) => void;
  closeGateway: () => Promise<void>;
  admin: AdminCommandTarget;
};

export type HostRelay = {
  onHostMessage: (message: HostToMain) => void;
  wrapBridge: (inner: HostBridge) => HostBridge;
};

function transformRemoteResponse(
  target: PendingCommand,
  conn: ClientConn,
  rawResult: unknown,
  deps: Pick<HostRelayDeps, 'log' | 'outputBuffer' | 'sendWs'>,
): { ok: true; result: unknown } | { ok: false } {
  if (target.method === 'workspace.activate') {
    try {
      return { ok: true, result: toRemoteSnapshot(rawResult as Parameters<typeof toRemoteSnapshot>[0]) };
    } catch (error) {
      deps.log.error({ err: error }, 'snapshot remoto inválido');
      deps.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: { code: 'INTERNAL', message: 'Resposta inválida do núcleo.' } });
      return { ok: false };
    }
  }
  if (target.method === 'workspace.list') {
    try {
      return { ok: true, result: toRemoteWorkspaceList(rawResult as Parameters<typeof toRemoteWorkspaceList>[0]) };
    } catch (error) {
      deps.log.error({ err: error }, 'lista de workspaces remota inválida');
      deps.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: { code: 'INTERNAL', message: 'Resposta inválida do núcleo.' } });
      return { ok: false };
    }
  }
  if (target.method === 'terminal.snapshot' && target.terminal) {
    // A saída acumulada até aqui já está no retrato: descartar evita linhas repetidas e libera o terminal mudo.
    for (const [key, entry] of conn.output) if (entry.name === target.terminal) conn.output.delete(key);
    deps.outputBuffer.recomputeOutputBytes(conn);
    conn.overflowed.delete(target.terminal);
  }
  return { ok: true, result: rawResult };
}

/** Cria o roteador de mensagens entre o núcleo (workspace-manager), o Electron e os clientes remotos. */
export function createHostRelay(deps: HostRelayDeps): HostRelay {
  function relayResponse(message: Extract<HostToMain, { kind: 'response' | 'response-error' }>): void {
    const target = deps.wsSessions.takePending(message.id);
    if (target) {
      const conn = deps.wsSessions.getClient(target.connId);
      if (!conn || !conn.device) return;
      if (message.kind === 'response-error') {
        deps.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: message.error });
        return;
      }
      const transformed = transformRemoteResponse(target, conn, message.result, deps);
      if (transformed.ok) {
        deps.sendWs(conn.ws, { type: 'response', id: target.clientCmdId, ok: true, result: transformed.result });
      }
      return;
    }
    if (message.id.startsWith('remote:')) return;
    deps.electronSend(message);
  }

  function relayEvent(message: Extract<HostToMain, { kind: 'event' }>): void {
    deps.electronSend(message);
    const event = message.event;
    if (!isRemoteAllowedEvent(event.type)) return;
    if (event.type === 'workspace.activated') {
      // As assinaturas valem para o workspace ativo: trocar de workspace as encerra.
      deps.wsSessions.forEachClient((conn) => {
        for (const key of [...conn.subscriptions]) if (!key.startsWith(`${event.workspaceId}:`)) conn.subscriptions.delete(key);
        for (const [key, entry] of [...conn.output]) if (entry.workspaceId !== event.workspaceId) conn.output.delete(key);
        deps.outputBuffer.recomputeOutputBytes(conn);
        conn.overflowed.clear();
      });
    }
    deps.wsSessions.forEachAuthedClient((conn) => {
      if (event.type === 'terminal.output') {
        if (!conn.subscriptions.has(`${event.workspaceId ?? ''}:${event.name}`)) return;
        deps.outputBuffer.queueOutput(conn, event);
        return;
      }
      deps.sendWs(conn.ws, { type: 'event', event });
    });
  }

  function onHostMessage(message: HostToMain): void {
    if (message.kind === 'response' || message.kind === 'response-error') {
      relayResponse(message);
      return;
    }
    if (message.kind === 'event') {
      relayEvent(message);
      return;
    }
    // confirm, portal-call, portal-cancel e ready pertencem somente ao desktop.
    deps.electronSend(message);
  }

  async function handleAdminCommand(method: string, params: unknown): Promise<unknown> {
    if (method === 'remote.status') {
      parseHostParams('remote.status', params);
      return deps.admin.status();
    }
    if (method === 'remote.enable') {
      const { enabled, fallbackHttp } = parseHostParams('remote.enable', params);
      return deps.admin.enable(enabled, { fallbackHttp });
    }
    if (method === 'remote.pair') {
      parseHostParams('remote.pair', params);
      return deps.admin.pair();
    }
    if (method === 'remote.devices') {
      parseHostParams('remote.devices', params);
      return deps.admin.devices();
    }
    if (method === 'remote.revoke') {
      const { id } = parseHostParams('remote.revoke', params);
      deps.admin.revoke(id);
      return {};
    }
    throw new OrqError('USAGE', `Comando remoto desconhecido: ${method}.`);
  }

  function wrapBridge(inner: HostBridge): HostBridge {
    deps.attachBridge(inner);
    return {
      handle: async (message: Exclude<MainToHost, { kind: 'shutdown' }>) => {
        if (message.kind === 'command' && message.method.startsWith('remote.')) {
          try {
            const result = await handleAdminCommand(message.method, message.params);
            deps.electronSend({ kind: 'response', id: message.id, ok: true, result });
          } catch (error) {
            if (!(error instanceof OrqError)) {
              deps.log.error({ err: error, method: message.method }, 'erro interno no acesso remoto');
            }
            const orq = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do acesso remoto.');
            deps.electronSend({
              kind: 'response-error',
              id: message.id,
              error: { code: orq.code, message: orq.message },
            });
          }
          return;
        }
        await inner.handle(message);
      },
      dispatchForTest: (method, params, caller) => inner.dispatchForTest(method, params, caller),
      close: async () => {
        await deps.closeGateway();
        await inner.close();
      },
    };
  }

  return { onHostMessage, wrapBridge };
}
