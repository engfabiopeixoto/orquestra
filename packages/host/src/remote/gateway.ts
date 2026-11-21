import {
  OrqError,
  REMOTE_AUTH_TIMEOUT_MS,
  REMOTE_DEFAULT_PORT,
  REMOTE_OUTPUT_BUFFER_LIMIT,
  REMOTE_OUTPUT_FLUSH_MS,
  type HostToMain,
  type RemoteDevice,
  type RemotePairResult,
  type RemoteStatus,
} from '@orquestra/shared';
import type { HostBridge } from '../bridge.js';
import { RemoteDeviceStore } from './device-store.js';
import { createHostRelay, type HostRelay } from './gateway/host-relay.js';
import { createHttpHandler, defaultMobileDir } from './gateway/http.js';
import { createGatewayListeners, type GatewayListeners } from './gateway/listeners.js';
import { formatHostForUrl, isAllowedBindHost, isOriginAllowed, parseRequestUrl } from './gateway/origin.js';
import { createOutputBuffer } from './gateway/output-buffer.js';
import type { RemoteGatewayOptions } from './gateway/types.js';
import { createWsSessionManager, sendWs, type WsSessionManager } from './gateway/ws-session.js';
import { TailscaleServeManager, type TailscaleController } from './tailscale.js';

export { isAllowedBindHost } from './gateway/origin.js';
export type { RemoteGatewayOptions } from './gateway/types.js';

function resolveTailscaleController(opts: RemoteGatewayOptions): TailscaleController | null {
  if (opts.tailscale === false) return null;
  if (opts.tailscale) return opts.tailscale;
  if (!process.env.VITEST) return new TailscaleServeManager({ log: opts.log });
  return null;
}

/** Fachada do gateway remoto: coordena ciclo de vida, dispositivos pareados e módulos de transporte. */
export class RemoteGateway {
  readonly store: RemoteDeviceStore;
  private readonly host: string;
  private readonly persistEnabledState: boolean;
  private readonly listeners: GatewayListeners;
  private readonly wsSessions: WsSessionManager;
  private readonly relay: HostRelay;
  private bridge: HostBridge | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RemoteGatewayOptions) {
    const bindHost = (opts.host ?? '127.0.0.1').trim();
    if (!isAllowedBindHost(bindHost)) {
      throw new OrqError('USAGE', `Endereço de escuta não permitido para o gateway remoto: ${bindHost}. Use apenas loopback ou IP Tailscale (100.64.0.0/10).`);
    }
    this.host = bindHost === '[::1]' ? '::1' : bindHost;
    this.persistEnabledState = opts.persistEnabledState ?? true;

    this.store = new RemoteDeviceStore({
      dataDir: opts.dataDir,
      log: opts.log,
      now: opts.now,
      pairTtlMs: opts.pairTtlMs,
      rateLimit: opts.rateLimit,
      rateWindowMs: opts.rateWindowMs,
    });

    const outputBuffer = createOutputBuffer({
      outputFlushMs: opts.outputFlushMs ?? REMOTE_OUTPUT_FLUSH_MS,
      outputBufferLimit: opts.outputBufferLimit ?? REMOTE_OUTPUT_BUFFER_LIMIT,
      sendWs,
      log: opts.log,
    });

    this.wsSessions = createWsSessionManager({
      store: this.store,
      log: opts.log,
      authTimeoutMs: opts.authTimeoutMs ?? REMOTE_AUTH_TIMEOUT_MS,
      outputBuffer,
      isEnabled: () => this.listeners.isEnabled(),
      getBridge: () => this.bridge,
    });

    const extraAllowedOrigins = new Set(opts.allowedOrigins ?? []);
    const originCtx = {
      host: this.host,
      activePort: () => this.listeners.getActivePort(),
      tailscaleStatus: () => this.listeners.getTailscaleStatus(),
      extraAllowedOrigins,
    };
    const urlCheck = (req: Parameters<typeof parseRequestUrl>[1]) => parseRequestUrl(originCtx, req);
    const originCheck = (origin: string | undefined) => isOriginAllowed(originCtx, origin);

    const handleHttp = createHttpHandler({
      store: this.store,
      log: opts.log,
      mobileDir: opts.mobileDir?.trim() || defaultMobileDir(import.meta.url),
      isOriginAllowed: originCheck,
      parseRequestUrl: urlCheck,
    });

    this.listeners = createGatewayListeners({
      host: this.host,
      configuredPort: opts.port ?? REMOTE_DEFAULT_PORT,
      fallbackBindHost: opts.fallbackBindHost,
      tailscale: resolveTailscaleController(opts),
      log: opts.log,
      isOriginAllowed: originCheck,
      parseRequestUrl: urlCheck,
      handleHttp,
      onWsConnection: (ws) => this.wsSessions.handleWsConnection(ws),
      onStopClients: () => this.wsSessions.closeAllClients(),
    });

    this.relay = createHostRelay({
      log: opts.log,
      electronSend: opts.electronSend,
      wsSessions: this.wsSessions,
      outputBuffer,
      sendWs,
      attachBridge: (bridge) => this.attachBridge(bridge),
      closeGateway: () => this.close(),
      admin: {
        status: () => this.status(),
        enable: (enabled, adminOpts) => this.enable(enabled, adminOpts),
        pair: () => this.pair(),
        devices: () => this.devices(),
        revoke: (id) => this.revoke(id),
      },
    });
  }

  attachBridge(bridge: HostBridge): void {
    this.bridge = bridge;
  }

  async init(initialEnabled?: boolean): Promise<void> {
    const shouldStart = initialEnabled ?? this.store.isEnabled();
    if (shouldStart) await this.enqueueLifecycle(() => this.listeners.startListening());
  }

  private enqueueLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(work);
    this.lifecycle = task.catch(() => {});
    return task;
  }

  status(): RemoteStatus {
    const activePort = this.listeners.getActivePort();
    return {
      enabled: this.listeners.isEnabled(),
      port: activePort,
      localUrl: `http://${formatHostForUrl(this.host)}:${activePort}`,
      devicesCount: this.store.list().length,
      tailscale: { ...this.listeners.getTailscaleStatus() },
    };
  }

  enable(enabled: boolean, opts?: { fallbackHttp?: boolean }): Promise<RemoteStatus> {
    return this.enqueueLifecycle(async () => {
      if (enabled) {
        await this.listeners.startListening();
        if (opts?.fallbackHttp) {
          await this.listeners.startFallbackListening();
        }
        if (this.persistEnabledState) this.store.setEnabled(true);
      } else {
        if (this.persistEnabledState) this.store.setEnabled(false);
        await this.listeners.stopListening();
      }
      return this.status();
    });
  }

  pair(): RemotePairResult {
    if (!this.listeners.isEnabled()) {
      throw new OrqError('USAGE', 'Ligue o acesso remoto antes de gerar um link de pareamento.');
    }
    const { token, expiresAt } = this.store.createPairing();
    const baseUrl = this.listeners.getTailscaleStatus().url ?? `http://${formatHostForUrl(this.host)}:${this.listeners.getActivePort()}`;
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
    this.wsSessions.revokeConnectionsForDevice(id);
    this.opts.log.info({ deviceId: id }, 'dispositivo remoto revogado');
  }

  async close(): Promise<void> {
    await this.enqueueLifecycle(() => this.listeners.stopListening());
  }

  /**
   * Roteia mensagens que saem do workspace-manager:
   * - respostas com prefixo `remote:` voltam somente à conexão de origem (nunca ao Electron)
   * - eventos permitidos vão ao Electron e aos clientes remotos autenticados (terminal.output só para assinantes)
   * - confirm e portal vão apenas para o Electron
   */
  onHostMessage(message: HostToMain): void {
    this.relay.onHostMessage(message);
  }

  /**
   * Envolve o HostBridge do workspace-manager para atender comandos `remote.*` vindos do Electron
   * e garantir fechamento ordenado do gateway no `close()`.
   */
  wrapBridge(inner: HostBridge): HostBridge {
    return this.relay.wrapBridge(inner);
  }
}
