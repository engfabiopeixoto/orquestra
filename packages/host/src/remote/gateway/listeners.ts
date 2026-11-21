import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from '@orquestra/core';
import {
  OrqError,
  REMOTE_MAX_MESSAGE_BYTES,
  type RemoteTailscaleStatus,
} from '@orquestra/shared';
import type { TailscaleController } from '../tailscale.js';
import { sendJson } from './http.js';
import { isAllowedBindHost } from './origin.js';
import type { OriginCheck, RequestUrlParser } from './types.js';

export const DISABLED_TAILSCALE_STATUS: RemoteTailscaleStatus = {
  state: 'disabled',
  dnsName: null,
  url: null,
  error: null,
  tailscaleIp: null,
};

export type GatewayListenersDeps = {
  host: string;
  configuredPort: number;
  fallbackBindHost?: string;
  tailscale: TailscaleController | null;
  log: Logger;
  isOriginAllowed: OriginCheck;
  parseRequestUrl: RequestUrlParser;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  onWsConnection: (ws: WebSocket) => void;
  onStopClients: () => void;
};

export type GatewayListeners = {
  isEnabled: () => boolean;
  getActivePort: () => number;
  getTailscaleStatus: () => RemoteTailscaleStatus;
  startListening: () => Promise<void>;
  startFallbackListening: () => Promise<void>;
  stopListening: () => Promise<void>;
};

function listenServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      rejectListen(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolveSrv) => server.close(() => resolveSrv()));
}

/** Cria o controlador de servidores HTTP/WebSocket, plano B no IP Tailscale e ciclo de escuta. */
export function createGatewayListeners(deps: GatewayListenersDeps): GatewayListeners {
  let server: Server | null = null;
  let fallbackServer: Server | null = null;
  let wss: WebSocketServer | null = null;
  let activePort = deps.configuredPort;
  let enabled = false;
  let tailscaleStatus: RemoteTailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };

  function createHttpServer(wsServer: WebSocketServer): Server {
    const httpServer = createServer((req, res) => {
      void deps.handleHttp(req, res).catch((error) => {
        deps.log.warn({ err: error }, 'erro inesperado na requisição HTTP remota');
        if (!res.headersSent) {
          sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Erro interno do servidor.' } });
        } else {
          res.end();
        }
      });
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = deps.parseRequestUrl(req);
      if (!url) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!deps.isOriginAllowed(req.headers.origin)) {
        deps.log.warn({ origin: req.headers.origin }, 'conexão WebSocket recusada: Origin inválida');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => deps.onWsConnection(ws));
    });

    return httpServer;
  }

  async function startListening(): Promise<void> {
    if (server) return;
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: REMOTE_MAX_MESSAGE_BYTES });
    const httpServer = createHttpServer(wsServer);

    try {
      await listenServer(httpServer, deps.configuredPort, deps.host);
    } catch (error) {
      try { httpServer.close(); } catch {}
      try { wsServer.close(); } catch {}
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new OrqError('CONFLICT', `A porta ${deps.configuredPort} já está em uso por outro processo.`);
      }
      throw error;
    }

    const address = httpServer.address() as AddressInfo | null;
    activePort = address?.port ?? deps.configuredPort;
    server = httpServer;
    wss = wsServer;
    enabled = true;
    if (deps.tailscale) {
      tailscaleStatus = await deps.tailscale.startServe(activePort);
    } else {
      tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };
    }
    deps.log.info({ host: deps.host, port: activePort }, 'gateway remoto ligado');
  }

  async function startFallbackListening(): Promise<void> {
    if (!wss) {
      throw new OrqError('APP_UNAVAILABLE', 'Ligue o gateway remoto antes de ativar o plano B.');
    }
    const tsIp = tailscaleStatus.tailscaleIp?.trim() ?? '';
    if (!tsIp || !isAllowedBindHost(tsIp) || !tsIp.startsWith('100.')) {
      throw new OrqError('APP_UNAVAILABLE', 'IP 100.x do Tailscale indisponível neste computador.');
    }
    const bindHost = (deps.fallbackBindHost ?? tsIp).trim();
    if (!isAllowedBindHost(bindHost)) {
      throw new OrqError('USAGE', `Endereço de escuta do plano B não permitido: ${bindHost}.`);
    }
    if (!fallbackServer) {
      const fbServer = createHttpServer(wss);
      try {
        await listenServer(fbServer, activePort, bindHost);
        fallbackServer = fbServer;
      } catch (error) {
        try { fbServer.close(); } catch {}
        throw new OrqError(
          'APP_UNAVAILABLE',
          `Não foi possível ouvir no IP do Tailscale (${tsIp}:${activePort}): ${(error as Error).message}`,
        );
      }
    }
    tailscaleStatus = {
      ...tailscaleStatus,
      state: 'fallback',
      url: `http://${tsIp}:${activePort}`,
    };
    deps.log.info({ ip: tsIp, port: activePort }, 'gateway remoto ouvindo também no IP do Tailscale (plano B)');
  }

  async function stopListening(): Promise<void> {
    if (!enabled && !server && !fallbackServer) {
      tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };
      return;
    }
    enabled = false;
    activePort = deps.configuredPort;

    if (deps.tailscale) {
      await deps.tailscale.stopServe();
    }
    tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };

    deps.onStopClients();

    const activeWss = wss;
    const activeFb = fallbackServer;
    const activeSrv = server;
    wss = null;
    fallbackServer = null;
    server = null;

    if (activeWss) {
      await new Promise<void>((resolveWss) => activeWss.close(() => resolveWss()));
    }
    await closeHttpServer(activeFb);
    await closeHttpServer(activeSrv);
    deps.log.info('gateway remoto desligado');
  }

  return {
    isEnabled: () => enabled,
    getActivePort: () => activePort,
    getTailscaleStatus: () => tailscaleStatus,
    startListening,
    startFallbackListening,
    stopListening,
  };
}
