import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  isHostMethod,
  isRemoteAllowedEvent,
  isRemoteAllowedMethod,
  OrqError,
  parseHostParams,
  REMOTE_AUTH_TIMEOUT_MS,
  REMOTE_DEFAULT_PORT,
  REMOTE_MAX_MESSAGE_BYTES,
  REMOTE_MAX_SUBSCRIPTIONS,
  REMOTE_OUTPUT_BUFFER_LIMIT,
  REMOTE_OUTPUT_FLUSH_MS,
  remoteClientMessageSchema,
  remotePairRequestSchema,
  toRemoteSnapshot,
  toRemoteWorkspaceList,
  type HostToMain,
  type MainToHost,
  type RemoteDevice,
  type RemotePairResult,
  type RemoteServerMessage,
  type RemoteStatus,
  type RemoteTailscaleStatus,
} from '@orquestra/shared';
import type { Logger } from '@orquestra/core';
import type { HostBridge } from '../bridge.js';
import { RemoteDeviceStore } from './device-store.js';
import { TailscaleServeManager, type TailscaleController } from './tailscale.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Permite somente loopback (`127.0.0.0/8`, `::1`) ou IP CGNAT do Tailscale (`100.64.0.0/10`).
 * Recusa `0.0.0.0`, `::`, LAN comum e hostnames para nunca abrir porta pública.
 */
export function isAllowedBindHost(host: string): boolean {
  const clean = host.trim();
  if (clean === '::1' || clean === '[::1]') return true;
  const parts = clean.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function defaultMobileDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const envDir = process.env.ORQ_MOBILE_DIR?.trim();
  const candidates = [
    ...(envDir ? [envDir] : []),
    ...(resourcesPath ? [join(resourcesPath, 'mobile')] : []),
    resolve(here, '../mobile'),
    resolve(here, '../../../mobile/dist'),
    resolve(here, '../../mobile/dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return candidates[0]!;
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

type ClientConn = {
  id: string;
  ws: WebSocket;
  device: RemoteDevice | null;
  authTimer: NodeJS.Timeout | null;
  subscriptions: Set<string>;
  /** Saída pendente por terminal, agrupada a cada REMOTE_OUTPUT_FLUSH_MS. */
  output: Map<string, { name: string; workspaceId?: string; data: string; sequence?: number }>;
  outputBytes: number;
  outputTimer: NodeJS.Timeout | null;
  /** Terminais cuja saída foi descartada por excesso: ficam mudos até o cliente pedir um snapshot novo. */
  overflowed: Set<string>;
};

export type RemoteGatewayOptions = {
  dataDir: string;
  log: Logger;
  electronSend: (message: HostToMain) => void;
  port?: number;
  host?: string;
  mobileDir?: string;
  authTimeoutMs?: number;
  pairTtlMs?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  allowedOrigins?: string[];
  outputFlushMs?: number;
  outputBufferLimit?: number;
  persistEnabledState?: boolean;
  tailscale?: TailscaleController | false;
  fallbackBindHost?: string;
  now?: () => number;
};

const DISABLED_TAILSCALE_STATUS: RemoteTailscaleStatus = {
  state: 'disabled',
  dnsName: null,
  url: null,
  error: null,
  tailscaleIp: null,
};

export class RemoteGateway {
  readonly store: RemoteDeviceStore;
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly mobileDir: string;
  private readonly authTimeoutMs: number;
  private readonly persistEnabledState: boolean;
  private readonly outputFlushMs: number;
  private readonly outputBufferLimit: number;
  private readonly extraAllowedOrigins: Set<string>;
  private readonly tailscale: TailscaleController | null;
  private server: Server | null = null;
  private fallbackServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private activePort: number;
  private enabled = false;
  private tailscaleStatus: RemoteTailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };
  private bridge: HostBridge | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly clients = new Map<string, ClientConn>();
  private readonly pending = new Map<string, { connId: string; clientCmdId: string; method: string; terminal?: string }>();

  constructor(private readonly opts: RemoteGatewayOptions) {
    const bindHost = (opts.host ?? '127.0.0.1').trim();
    if (!isAllowedBindHost(bindHost)) {
      throw new OrqError('USAGE', `Endereço de escuta não permitido para o gateway remoto: ${bindHost}. Use apenas loopback ou IP Tailscale (100.64.0.0/10).`);
    }
    this.host = bindHost === '[::1]' ? '::1' : bindHost;
    this.configuredPort = opts.port ?? REMOTE_DEFAULT_PORT;
    this.activePort = this.configuredPort;
    this.mobileDir = opts.mobileDir?.trim() || defaultMobileDir();
    this.authTimeoutMs = opts.authTimeoutMs ?? REMOTE_AUTH_TIMEOUT_MS;
    this.persistEnabledState = opts.persistEnabledState ?? true;
    this.outputFlushMs = opts.outputFlushMs ?? REMOTE_OUTPUT_FLUSH_MS;
    this.outputBufferLimit = opts.outputBufferLimit ?? REMOTE_OUTPUT_BUFFER_LIMIT;
    this.extraAllowedOrigins = new Set(opts.allowedOrigins ?? []);
    if (opts.tailscale === false) {
      this.tailscale = null;
    } else if (opts.tailscale) {
      this.tailscale = opts.tailscale;
    } else if (!process.env.VITEST) {
      this.tailscale = new TailscaleServeManager({ log: opts.log });
    } else {
      this.tailscale = null;
    }
    this.store = new RemoteDeviceStore({
      dataDir: opts.dataDir,
      log: opts.log,
      now: opts.now,
      pairTtlMs: opts.pairTtlMs,
      rateLimit: opts.rateLimit,
      rateWindowMs: opts.rateWindowMs,
    });
  }

  attachBridge(bridge: HostBridge): void {
    this.bridge = bridge;
  }

  async init(initialEnabled?: boolean): Promise<void> {
    const shouldStart = initialEnabled ?? this.store.isEnabled();
    if (shouldStart) await this.enqueueLifecycle(() => this.startListening());
  }

  private enqueueLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(work);
    this.lifecycle = task.catch(() => {});
    return task;
  }

  private formatHostForUrl(): string {
    return this.host.includes(':') ? `[${this.host}]` : this.host;
  }

  status(): RemoteStatus {
    return {
      enabled: this.enabled,
      port: this.activePort,
      localUrl: `http://${this.formatHostForUrl()}:${this.activePort}`,
      devicesCount: this.store.list().length,
      tailscale: { ...this.tailscaleStatus },
    };
  }

  enable(enabled: boolean, opts?: { fallbackHttp?: boolean }): Promise<RemoteStatus> {
    return this.enqueueLifecycle(async () => {
      if (enabled) {
        await this.startListening();
        if (opts?.fallbackHttp) {
          await this.startFallbackListening();
        }
        if (this.persistEnabledState) this.store.setEnabled(true);
      } else {
        if (this.persistEnabledState) this.store.setEnabled(false);
        await this.stopListening();
      }
      return this.status();
    });
  }

  pair(): RemotePairResult {
    if (!this.enabled) {
      throw new OrqError('USAGE', 'Ligue o acesso remoto antes de gerar um link de pareamento.');
    }
    const { token, expiresAt } = this.store.createPairing();
    const baseUrl = this.tailscaleStatus.url ?? `http://${this.formatHostForUrl()}:${this.activePort}`;
    return {
      token,
      url: `${baseUrl}/?pair=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  devices(): { devices: RemoteDevice[] } {
    return { devices: this.store.list() };
  }

  revoke(id: string): void {
    if (!this.store.revoke(id)) {
      throw new OrqError('NOT_FOUND', 'Dispositivo não encontrado.');
    }
    for (const conn of [...this.clients.values()]) {
      if (conn.device?.id === id) {
        conn.device = null;
        if (conn.authTimer) {
          clearTimeout(conn.authTimer);
          conn.authTimer = null;
        }
        this.clearOutput(conn);
        this.clients.delete(conn.id);
        this.clearPendingFor(conn.id);
        this.sendWs(conn.ws, {
          type: 'auth-error',
          error: { code: 'INVALID_TOKEN', message: 'Dispositivo revogado.' },
        });
        conn.ws.close(4003, 'Dispositivo revogado');
        setTimeout(() => {
          try { conn.ws.terminate(); } catch {}
        }, 1000).unref();
      }
    }
    this.opts.log.info({ deviceId: id }, 'dispositivo remoto revogado');
  }

  private clearOutput(conn: ClientConn): void {
    if (conn.outputTimer) clearTimeout(conn.outputTimer);
    conn.outputTimer = null;
    conn.output.clear();
    conn.outputBytes = 0;
  }

  private recomputeOutputBytes(conn: ClientConn): void {
    let total = 0;
    for (const entry of conn.output.values()) {
      total += entry.data.length;
    }
    conn.outputBytes = total;
    if (conn.output.size === 0 && conn.outputTimer) {
      clearTimeout(conn.outputTimer);
      conn.outputTimer = null;
    }
  }

  private flushOutput(conn: ClientConn): void {
    if (conn.outputTimer) clearTimeout(conn.outputTimer);
    conn.outputTimer = null;
    const entries = [...conn.output.values()];
    conn.output.clear();
    conn.outputBytes = 0;
    if (!conn.device) return;
    for (const entry of entries) {
      this.sendWs(conn.ws, {
        type: 'event',
        event: { type: 'terminal.output', name: entry.name, data: entry.data, workspaceId: entry.workspaceId, sequence: entry.sequence },
      });
    }
  }

  /** Agrupa a saída por conexão; passou do limite, descarta tudo e avisa para pedir snapshot novo. */
  private queueOutput(conn: ClientConn, event: { name: string; data: string; workspaceId?: string; sequence?: number }): void {
    if (conn.overflowed.has(event.name)) return;
    const key = `${event.workspaceId ?? ''}:${event.name}`;
    const current = conn.output.get(key);
    conn.output.set(key, { name: event.name, workspaceId: event.workspaceId, data: (current?.data ?? '') + event.data, sequence: event.sequence });
    conn.outputBytes += event.data.length;
    if (conn.outputBytes > this.outputBufferLimit) {
      const dropped = [...conn.output.values()];
      this.clearOutput(conn);
      for (const entry of dropped) {
        conn.overflowed.add(entry.name);
        this.sendWs(conn.ws, { type: 'output-overflow', name: entry.name, workspaceId: entry.workspaceId });
      }
      this.opts.log.warn({ deviceId: conn.device?.id }, 'saída remota descartada por excesso de buffer');
      return;
    }
    if (!conn.outputTimer) conn.outputTimer = setTimeout(() => this.flushOutput(conn), this.outputFlushMs);
  }

  private clearPendingFor(connId: string): void {
    for (const [internalId, entry] of this.pending) {
      if (entry.connId === connId) this.pending.delete(internalId);
    }
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    const hostUrl = this.formatHostForUrl();
    const allowed = new Set<string>([
      `http://${hostUrl}:${this.activePort}`,
      `http://127.0.0.1:${this.activePort}`,
      `http://localhost:${this.activePort}`,
      ...(this.tailscaleStatus.url ? [this.tailscaleStatus.url] : []),
      ...(this.tailscaleStatus.state === 'fallback' && this.tailscaleStatus.tailscaleIp
        ? [`http://${this.tailscaleStatus.tailscaleIp}:${this.activePort}`]
        : []),
      ...this.extraAllowedOrigins,
    ]);
    return allowed.has(origin);
  }

  private parseRequestUrl(req: IncomingMessage): URL | null {
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    try {
      return new URL(raw, `http://${this.formatHostForUrl()}:${this.activePort}`);
    } catch {
      return null;
    }
  }

  private createHttpServer(wss: WebSocketServer): Server {
    const server = createServer((req, res) => {
      void this.handleHttp(req, res).catch((error) => {
        this.opts.log.warn({ err: error }, 'erro inesperado na requisição HTTP remota');
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Erro interno do servidor.' } });
        } else {
          res.end();
        }
      });
    });

    server.on('upgrade', (req, socket, head) => {
      const url = this.parseRequestUrl(req);
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
      if (!this.isOriginAllowed(req.headers.origin)) {
        this.opts.log.warn({ origin: req.headers.origin }, 'conexão WebSocket recusada: Origin inválida');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.handleWsConnection(ws));
    });

    return server;
  }

  private async startListening(): Promise<void> {
    if (this.server) return;
    const wss = new WebSocketServer({ noServer: true, maxPayload: REMOTE_MAX_MESSAGE_BYTES });
    const server = this.createHttpServer(wss);

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
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
        server.listen(this.configuredPort, this.host);
      });
    } catch (error) {
      try { server.close(); } catch {}
      try { wss.close(); } catch {}
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new OrqError('CONFLICT', `A porta ${this.configuredPort} já está em uso por outro processo.`);
      }
      throw error;
    }

    const address = server.address() as AddressInfo | null;
    this.activePort = address?.port ?? this.configuredPort;
    this.server = server;
    this.wss = wss;
    this.enabled = true;
    if (this.tailscale) {
      this.tailscaleStatus = await this.tailscale.startServe(this.activePort);
    } else {
      this.tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };
    }
    this.opts.log.info({ host: this.host, port: this.activePort }, 'gateway remoto ligado');
  }

  private async startFallbackListening(): Promise<void> {
    if (!this.wss) {
      throw new OrqError('APP_UNAVAILABLE', 'Ligue o gateway remoto antes de ativar o plano B.');
    }
    const tsIp = this.tailscaleStatus.tailscaleIp?.trim() ?? '';
    if (!tsIp || !isAllowedBindHost(tsIp) || !tsIp.startsWith('100.')) {
      throw new OrqError('APP_UNAVAILABLE', 'IP 100.x do Tailscale indisponível neste computador.');
    }
    const bindHost = (this.opts.fallbackBindHost ?? tsIp).trim();
    if (!isAllowedBindHost(bindHost)) {
      throw new OrqError('USAGE', `Endereço de escuta do plano B não permitido: ${bindHost}.`);
    }
    if (!this.fallbackServer) {
      const fbServer = this.createHttpServer(this.wss);
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (err: Error) => {
            fbServer.off('listening', onListening);
            rejectListen(err);
          };
          const onListening = () => {
            fbServer.off('error', onError);
            resolveListen();
          };
          fbServer.once('error', onError);
          fbServer.once('listening', onListening);
          fbServer.listen(this.activePort, bindHost);
        });
        this.fallbackServer = fbServer;
      } catch (error) {
        try { fbServer.close(); } catch {}
        throw new OrqError(
          'APP_UNAVAILABLE',
          `Não foi possível ouvir no IP do Tailscale (${tsIp}:${this.activePort}): ${(error as Error).message}`,
        );
      }
    }
    this.tailscaleStatus = {
      ...this.tailscaleStatus,
      state: 'fallback',
      url: `http://${tsIp}:${this.activePort}`,
    };
    this.opts.log.info({ ip: tsIp, port: this.activePort }, 'gateway remoto ouvindo também no IP do Tailscale (plano B)');
  }

  private async stopListening(): Promise<void> {
    if (!this.enabled && !this.server && !this.fallbackServer) {
      this.tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };
      return;
    }
    this.enabled = false;
    this.activePort = this.configuredPort;

    if (this.tailscale) {
      await this.tailscale.stopServe();
    }
    this.tailscaleStatus = { ...DISABLED_TAILSCALE_STATUS };

    for (const conn of [...this.clients.values()]) {
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }
      conn.device = null;
      this.clearOutput(conn);
      this.clients.delete(conn.id);
      this.clearPendingFor(conn.id);
      try { conn.ws.close(1000, 'Acesso remoto desligado'); } catch {}
      try { conn.ws.terminate(); } catch {}
    }
    this.pending.clear();

    const wss = this.wss;
    const fbServer = this.fallbackServer;
    const server = this.server;
    this.wss = null;
    this.fallbackServer = null;
    this.server = null;

    if (wss) {
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
    }
    if (fbServer) {
      fbServer.closeIdleConnections?.();
      fbServer.closeAllConnections?.();
      await new Promise<void>((resolveFb) => fbServer.close(() => resolveFb()));
    }
    if (server) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolveSrv) => server.close(() => resolveSrv()));
    }
    this.opts.log.info('gateway remoto desligado');
  }

  async close(): Promise<void> {
    await this.enqueueLifecycle(() => this.stopListening());
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  private sendText(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > REMOTE_MAX_MESSAGE_BYTES) {
        throw new OrqError('USAGE', 'Corpo da requisição excede 64 KB.');
      }
      chunks.push(buf);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new OrqError('USAGE', 'JSON inválido.');
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = this.parseRequestUrl(req);
    if (!url) {
      return this.sendJson(res, 400, { error: { code: 'USAGE', message: 'URL inválida.' } });
    }
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/health') {
      return this.sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/me') {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const device = this.store.authenticate(token);
      if (!device) {
        return this.sendJson(res, 401, { error: { code: 'INVALID_TOKEN', message: 'Token ausente ou inválido.' } });
      }
      return this.sendJson(res, 200, { device });
    }

    if (method === 'POST' && url.pathname === '/api/pair') {
      if (!this.isOriginAllowed(req.headers.origin)) {
        return this.sendJson(res, 403, { error: { code: 'USAGE', message: 'Origem não permitida para pareamento.' } });
      }
      const contentType = req.headers['content-type']?.toLowerCase().split(';')[0]?.trim();
      if (contentType !== 'application/json') {
        return this.sendJson(res, 415, { error: { code: 'USAGE', message: 'Content-Type deve ser application/json.' } });
      }
      let body: unknown;
      try {
        body = await this.readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Requisição inválida.';
        const status = message.includes('64 KB') ? 413 : 400;
        return this.sendJson(res, status, { error: { code: 'USAGE', message } });
      }
      const parsed = remotePairRequestSchema.safeParse(body);
      if (!parsed.success) {
        const msg = parsed.error.issues[0]?.message ?? 'Dados de pareamento inválidos.';
        return this.sendJson(res, 400, { error: { code: 'USAGE', message: msg } });
      }
      const outcome = this.store.redeemPairing(parsed.data.pairToken, parsed.data.deviceName);
      if (!outcome.ok) {
        if (outcome.reason === 'rate_limit') {
          this.opts.log.warn('limite de tentativas de pareamento atingido');
          return this.sendJson(res, 429, { error: { code: 'CONFLICT', message: 'Muitas tentativas de pareamento. Aguarde um minuto.' } });
        }
        this.opts.log.warn('tentativa de pareamento com link inválido ou expirado');
        return this.sendJson(res, 401, { error: { code: 'INVALID_TOKEN', message: 'Link de pareamento inválido ou expirado.' } });
      }
      this.opts.log.info({ deviceId: outcome.device.id, deviceName: outcome.device.name }, 'dispositivo remoto pareado');
      return this.sendJson(res, 200, { deviceToken: outcome.deviceToken, device: outcome.device });
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      return this.serveStatic(url.pathname, res);
    }

    this.sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  }

  private isInsideRoot(realRoot: string, realTarget: string): boolean {
    const rel = relative(realRoot, realTarget);
    if (rel === '') return true;
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const root = resolve(this.mobileDir);
    if (!existsSync(root)) {
      return this.sendText(res, 503, 'Build do aplicativo móvel não encontrado.');
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return this.sendText(res, 400, 'Caminho inválido.');
    }

    if (decoded.includes('\0')) {
      return this.sendText(res, 403, 'Acesso negado.');
    }

    const stripped = decoded.replace(/^\/+/, '');
    const segments = stripped.split(/[\\/]+/);
    if (isAbsolute(stripped) || segments.includes('..')) {
      return this.sendText(res, 403, 'Acesso negado.');
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return this.sendText(res, 503, 'Build do aplicativo móvel não encontrado.');
    }

    const cleanRel = stripped === '' ? 'index.html' : normalize(stripped);
    const candidate = resolve(realRoot, cleanRel);
    if (!this.isInsideRoot(realRoot, candidate)) {
      return this.sendText(res, 403, 'Acesso negado.');
    }

    let target = candidate;
    if (existsSync(target)) {
      let realTarget: string;
      let stats: ReturnType<typeof statSync>;
      try {
        realTarget = realpathSync(target);
        if (!this.isInsideRoot(realRoot, realTarget)) {
          return this.sendText(res, 403, 'Acesso negado.');
        }
        stats = statSync(realTarget);
      } catch {
        return this.sendText(res, 403, 'Acesso negado.');
      }
      if (stats.isDirectory()) {
        target = join(realRoot, 'index.html');
      } else if (!stats.isFile()) {
        return this.sendText(res, 403, 'Acesso negado.');
      } else {
        target = realTarget;
      }
    } else {
      target = join(realRoot, 'index.html');
    }

    if (!existsSync(target)) {
      return this.sendText(res, 404, 'Arquivo não encontrado.');
    }

    let finalReal: string;
    try {
      finalReal = realpathSync(target);
      if (!this.isInsideRoot(realRoot, finalReal) || !statSync(finalReal).isFile()) {
        return this.sendText(res, 403, 'Acesso negado.');
      }
    } catch {
      return this.sendText(res, 404, 'Arquivo não encontrado.');
    }

    const ext = extname(finalReal).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const noCache = ext === '.html' || ext === '.webmanifest' || finalReal.endsWith(`${sep}sw.js`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(readFileSync(finalReal));
  }

  private sendWs(ws: WebSocket, message: RemoteServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private handleWsConnection(ws: WebSocket): void {
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
          this.clients.delete(connId);
          // Usa type: 'error' no timeout de rede para o cliente tentar reconectar com backoff.
          this.sendWs(ws, {
            type: 'error',
            error: { code: 'INVALID_TOKEN', message: 'Autenticação não recebida no prazo de 5 segundos.' },
          });
          ws.close(4001, 'Tempo de autenticação esgotado');
        }
      }, this.authTimeoutMs),
    };
    this.clients.set(connId, conn);

    ws.on('error', (error) => {
      this.opts.log.warn({ connId, err: error.message }, 'erro na conexão WebSocket remota');
    });

    ws.on('close', () => {
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }
      conn.device = null;
      this.clearOutput(conn);
      this.clients.delete(connId);
      this.clearPendingFor(connId);
    });

    ws.on('message', (raw) => {
      if (!this.enabled || !this.clients.has(connId) || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const buf = rawDataToBuffer(raw);
      if (buf.length > REMOTE_MAX_MESSAGE_BYTES) {
        this.sendWs(ws, { type: 'error', error: { code: 'USAGE', message: 'Mensagem excede 64 KB.' } });
        ws.close(1009, 'Mensagem excede 64 KB');
        return;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(buf.toString('utf8'));
      } catch {
        this.sendWs(ws, { type: 'error', error: { code: 'USAGE', message: 'JSON inválido.' } });
        if (!conn.device) ws.close(4001, 'Mensagem inicial inválida');
        return;
      }

      const parsed = remoteClientMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        this.sendWs(ws, { type: 'error', error: { code: 'USAGE', message: 'Formato de mensagem inválido.' } });
        if (!conn.device) ws.close(4001, 'Mensagem inicial inválida');
        return;
      }

      const msg = parsed.data;
      if (!conn.device) {
        if (msg.type !== 'auth') {
          this.sendWs(ws, {
            type: 'auth-error',
            error: { code: 'INVALID_TOKEN', message: 'Autenticação obrigatória na primeira mensagem.' },
          });
          ws.close(4001, 'Autenticação obrigatória');
          return;
        }
        const device = this.store.authenticate(msg.token);
        if (!device) {
          this.sendWs(ws, {
            type: 'auth-error',
            error: { code: 'INVALID_TOKEN', message: 'Token de dispositivo inválido ou revogado.' },
          });
          ws.close(4003, 'Token inválido');
          return;
        }
        if (conn.authTimer) {
          clearTimeout(conn.authTimer);
          conn.authTimer = null;
        }
        conn.device = device;
        this.opts.log.info({ deviceId: device.id, deviceName: device.name }, 'cliente remoto autenticado');
        this.sendWs(ws, { type: 'auth-ok', device });
        return;
      }

      if (msg.type === 'subscribe') {
        if (!conn.subscriptions.has(`${msg.workspaceId}:${msg.name}`) && conn.subscriptions.size >= REMOTE_MAX_SUBSCRIPTIONS) {
          this.sendWs(ws, { type: 'error', error: { code: 'USAGE', message: 'Assinaturas demais nesta conexão.' } });
          return;
        }
        conn.subscriptions.add(`${msg.workspaceId}:${msg.name}`);
        return;
      }
      if (msg.type === 'unsubscribe') {
        conn.subscriptions.delete(`${msg.workspaceId}:${msg.name}`);
        for (const [key, entry] of conn.output) if (entry.name === msg.name && key.startsWith(`${msg.workspaceId}:`)) conn.output.delete(key);
        this.recomputeOutputBytes(conn);
        conn.overflowed.delete(msg.name);
        return;
      }
      if (msg.type !== 'command') {
        this.sendWs(ws, { type: 'error', error: { code: 'USAGE', message: 'Cliente já autenticado.' } });
        return;
      }

      void this.dispatchRemoteCommand(conn, msg);
    });
  }

  private async dispatchRemoteCommand(
    conn: ClientConn,
    cmd: { id: string; method: string; params?: unknown; workspaceId?: string },
  ): Promise<void> {
    const device = conn.device;
    if (!device || !this.enabled || !this.clients.has(conn.id)) return;

    if (!isRemoteAllowedMethod(cmd.method) || !isHostMethod(cmd.method)) {
      this.opts.log.warn({ deviceId: device.id, deviceName: device.name, method: cmd.method }, 'comando remoto recusado');
      this.sendWs(conn.ws, {
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
      this.sendWs(conn.ws, {
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
    this.opts.log.info(
      { deviceId: device.id, deviceName: device.name, method: cmd.method, ...(terminalName ? { terminal: terminalName } : {}) },
      'comando remoto autorizado',
    );

    if (!this.bridge) {
      this.sendWs(conn.ws, {
        type: 'response-error',
        id: cmd.id,
        error: { code: 'APP_UNAVAILABLE', message: 'Núcleo indisponível.' },
      });
      return;
    }

    const internalId = `remote:${conn.id}:${randomUUID()}`;
    this.pending.set(internalId, { connId: conn.id, clientCmdId: cmd.id, method: cmd.method, terminal: terminalName });
    try {
      await this.bridge.handle({
        kind: 'command',
        id: internalId,
        method: cmd.method,
        params: validatedParams,
        workspaceId: cmd.workspaceId,
      });
    } catch (error) {
      if (this.pending.delete(internalId)) {
        const orq = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do Orquestra.');
        this.sendWs(conn.ws, {
          type: 'response-error',
          id: cmd.id,
          error: { code: orq.code, message: orq.message },
        });
      }
    }
  }

  /**
   * Roteia mensagens que saem do workspace-manager:
   * - respostas com prefixo `remote:` voltam somente à conexão de origem (nunca ao Electron)
   * - eventos permitidos vão ao Electron e aos clientes remotos autenticados (terminal.output só para assinantes)
   * - confirm e portal vão apenas para o Electron
   */
  onHostMessage(message: HostToMain): void {
    if (message.kind === 'response' || message.kind === 'response-error') {
      const target = this.pending.get(message.id);
      if (target) {
        this.pending.delete(message.id);
        const conn = this.clients.get(target.connId);
        if (conn && conn.device) {
          if (message.kind === 'response') {
            let result = message.result;
            if (target.method === 'workspace.activate') {
              try {
                result = toRemoteSnapshot(message.result as Parameters<typeof toRemoteSnapshot>[0]);
              } catch (error) {
                this.opts.log.error({ err: error }, 'snapshot remoto inválido');
                this.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: { code: 'INTERNAL', message: 'Resposta inválida do núcleo.' } });
                return;
              }
            } else if (target.method === 'workspace.list') {
              try {
                result = toRemoteWorkspaceList(message.result as Parameters<typeof toRemoteWorkspaceList>[0]);
              } catch (error) {
                this.opts.log.error({ err: error }, 'lista de workspaces remota inválida');
                this.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: { code: 'INTERNAL', message: 'Resposta inválida do núcleo.' } });
                return;
              }
            } else if (target.method === 'terminal.snapshot' && target.terminal) {
              // A saída acumulada até aqui já está no retrato: descartar evita linhas repetidas e libera o terminal mudo.
              for (const [key, entry] of conn.output) if (entry.name === target.terminal) conn.output.delete(key);
              this.recomputeOutputBytes(conn);
              conn.overflowed.delete(target.terminal);
            }
            this.sendWs(conn.ws, { type: 'response', id: target.clientCmdId, ok: true, result });
          } else {
            this.sendWs(conn.ws, { type: 'response-error', id: target.clientCmdId, error: message.error });
          }
        }
        return;
      }
      if (message.id.startsWith('remote:')) return;
      this.opts.electronSend(message);
      return;
    }

    if (message.kind === 'event') {
      this.opts.electronSend(message);
      const event = message.event;
      if (!isRemoteAllowedEvent(event.type)) return;
      if (event.type === 'workspace.activated') {
        // As assinaturas valem para o workspace ativo: trocar de workspace as encerra.
        for (const conn of this.clients.values()) {
          for (const key of [...conn.subscriptions]) if (!key.startsWith(`${event.workspaceId}:`)) conn.subscriptions.delete(key);
          for (const [key, entry] of [...conn.output]) if (entry.workspaceId !== event.workspaceId) conn.output.delete(key);
          this.recomputeOutputBytes(conn);
          conn.overflowed.clear();
        }
      }
      for (const conn of this.clients.values()) {
        if (!conn.device) continue;
        if (event.type === 'terminal.output') {
          if (!conn.subscriptions.has(`${event.workspaceId ?? ''}:${event.name}`)) continue;
          this.queueOutput(conn, event);
          continue;
        }
        this.sendWs(conn.ws, { type: 'event', event });
      }
      return;
    }

    // confirm, portal-call, portal-cancel e ready pertencem somente ao desktop.
    this.opts.electronSend(message);
  }

  /**
   * Envolve o HostBridge do workspace-manager para atender comandos `remote.*` vindos do Electron
   * e garantir fechamento ordenado do gateway no `close()`.
   */
  wrapBridge(inner: HostBridge): HostBridge {
    this.attachBridge(inner);
    return {
      handle: async (message: Exclude<MainToHost, { kind: 'shutdown' }>) => {
        if (message.kind === 'command' && message.method.startsWith('remote.')) {
          try {
            const result = await this.handleAdminCommand(message.method, message.params);
            this.opts.electronSend({ kind: 'response', id: message.id, ok: true, result });
          } catch (error) {
            if (!(error instanceof OrqError)) {
              this.opts.log.error({ err: error, method: message.method }, 'erro interno no acesso remoto');
            }
            const orq = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do acesso remoto.');
            this.opts.electronSend({
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
      cancelWork: inner.cancelWork ? () => inner.cancelWork!() : undefined,
      close: async () => {
        await this.close();
        await inner.close();
      },
    };
  }

  private async handleAdminCommand(method: string, params: unknown): Promise<unknown> {
    if (method === 'remote.status') {
      parseHostParams('remote.status', params);
      return this.status();
    }
    if (method === 'remote.enable') {
      const { enabled, fallbackHttp } = parseHostParams('remote.enable', params);
      return this.enable(enabled, { fallbackHttp });
    }
    if (method === 'remote.pair') {
      parseHostParams('remote.pair', params);
      return this.pair();
    }
    if (method === 'remote.devices') {
      parseHostParams('remote.devices', params);
      return this.devices();
    }
    if (method === 'remote.revoke') {
      const { id } = parseHostParams('remote.revoke', params);
      this.revoke(id);
      return {};
    }
    throw new OrqError('USAGE', `Comando remoto desconhecido: ${method}.`);
  }
}
