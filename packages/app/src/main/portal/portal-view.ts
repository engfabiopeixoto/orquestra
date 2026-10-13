import { shell, WebContentsView, type Session } from 'electron';
import {
  getDevicePreset,
  normalizePortalUrl,
  rotateDimensions,
  type DevicePreset,
  type PortalEvent,
  type PortalNavigationAction,
  type PortalOrientation,
  type PortalViewBounds,
} from '../../shared/portal-protocol';

export interface PortalViewOptions {
  portalId: string;
  tabId: string;
  workspaceId: string;
  session: Session;
  initialUrl?: string;
  presetId?: string;
  orientation?: PortalOrientation;
  onEvent(event: PortalEvent): void;
}

export class PortalView {
  readonly portalId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly view: WebContentsView;

  private currentUrl = 'about:blank';
  private currentTitle = 'Novo Portal';
  private currentFavicon?: string;
  private isDestroyed = false;
  private currentBounds: PortalViewBounds = { x: 0, y: 0, width: 800, height: 600 };
  private defaultUserAgent = '';
  private isEmulatingMobile = false;
  private readyForEmulation = false;
  private emulation?: { preset: DevicePreset; orientation: PortalOrientation };
  private touchMode?: boolean;

  constructor(private readonly opts: PortalViewOptions) {
    this.portalId = opts.portalId;
    this.tabId = opts.tabId;
    this.workspaceId = opts.workspaceId;
    this.currentUrl = opts.initialUrl ? normalizePortalUrl(opts.initialUrl) : 'about:blank';

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        session: opts.session,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    this.defaultUserAgent =
      typeof this.view.webContents.getUserAgent === 'function'
        ? this.view.webContents.getUserAgent()
        : '';
    this.setupListeners();

    if (opts.initialUrl) {
      void this.navigate(opts.initialUrl);
    }

    if (opts.presetId) {
      const preset = getDevicePreset(opts.presetId);
      if (preset.isMobile) {
        this.applyEmulation(preset, opts.orientation ?? 'portrait');
      }
    }
  }

  private setupListeners(): void {
    const wc = this.view.webContents;
    wc.on('dom-ready', () => {
      this.readyForEmulation = true;
      this.touchMode = undefined;
      if (this.emulation) this.applyEmulation(this.emulation.preset, this.emulation.orientation);
    });

    // Bloqueia esquemas não permitidos na navegação interna
    wc.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && url !== 'about:blank') {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });

    // Bloqueia popups e janelas não controladas, abrindo apenas http/https no navegador externo
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void shell.openExternal(url);
        }
      } catch {
        // Ignora
      }
      return { action: 'deny' };
    });

    wc.on('did-start-loading', () => {
      if (this.isDestroyed) return;
      this.opts.onEvent({
        type: 'portal:loading',
        portalId: this.portalId,
        tabId: this.tabId,
        isLoading: true,
      });
    });

    wc.on('did-stop-loading', () => {
      if (this.isDestroyed) return;
      this.opts.onEvent({
        type: 'portal:loading',
        portalId: this.portalId,
        tabId: this.tabId,
        isLoading: false,
      });
    });

    const onNavigated = (_event: unknown, url: string) => {
      if (this.isDestroyed) return;
      this.currentUrl = url;
      this.opts.onEvent({
        type: 'portal:navigated',
        portalId: this.portalId,
        tabId: this.tabId,
        url,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      });
    };

    wc.on('did-navigate', onNavigated);
    wc.on('did-navigate-in-page', onNavigated);

    wc.on('page-title-updated', (_event, title) => {
      if (this.isDestroyed) return;
      this.currentTitle = title;
      this.opts.onEvent({
        type: 'portal:title',
        portalId: this.portalId,
        tabId: this.tabId,
        title,
      });
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (this.isDestroyed || !favicons[0]) return;
      this.currentFavicon = favicons[0];
      this.opts.onEvent({
        type: 'portal:favicon',
        portalId: this.portalId,
        tabId: this.tabId,
        favicon: favicons[0],
      });
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (this.isDestroyed || errorCode === -3) return; // -3 é ABORTED (ex: ao navegar para outra URL)
      this.opts.onEvent({
        type: 'portal:error',
        portalId: this.portalId,
        tabId: this.tabId,
        error: `Falha ao carregar ${validatedURL}: ${errorDescription} (${errorCode})`,
      });
    });
  }

  async navigate(rawUrl: string): Promise<string> {
    if (this.isDestroyed) return this.currentUrl;
    const url = normalizePortalUrl(rawUrl);
    try {
      await this.view.webContents.loadURL(url);
      this.currentUrl = typeof this.view.webContents.getURL === 'function' ? this.view.webContents.getURL() || url : url;
    } catch (err) {
      // Ignora erro de abort caso outra navegação tenha sido disparada
      if ((err as { code?: string }).code !== 'ERR_ABORTED') {
        this.opts.onEvent({
          type: 'portal:error',
          portalId: this.portalId,
          tabId: this.tabId,
          error: (err as Error).message,
        });
      }
    }
    return this.currentUrl;
  }

  act(action: PortalNavigationAction): void {
    if (this.isDestroyed) return;
    const wc = this.view.webContents;
    switch (action) {
      case 'back':
        if (wc.canGoBack()) wc.goBack();
        break;
      case 'forward':
        if (wc.canGoForward()) wc.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'stop':
        wc.stop();
        break;
    }
  }

  applyEmulation(preset: DevicePreset, orientation: PortalOrientation): void {
    if (this.isDestroyed) return;
    this.emulation = { preset, orientation };
    if (!this.readyForEmulation) return;
    const wc = this.view.webContents;

    if (preset.isMobile) {
      const dims = rotateDimensions(preset.width, preset.height, orientation);
      wc.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: { width: dims.width, height: dims.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: preset.deviceScaleFactor,
        scale: Math.max(0.05, Math.min(1, this.currentBounds.width / dims.width, this.currentBounds.height / dims.height)),
        viewSize: { width: dims.width, height: dims.height },
      });
      if (preset.userAgent) {
        wc.setUserAgent(preset.userAgent);
      }
      this.isEmulatingMobile = true;
    } else {
      if (this.isEmulatingMobile) {
        wc.disableDeviceEmulation();
        this.isEmulatingMobile = false;
      }
      wc.setUserAgent(this.defaultUserAgent || '');
    }
    const debuggerApi = wc.debugger;
    if (debuggerApi && this.touchMode !== preset.isMobile) {
      try {
        if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
        void debuggerApi.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: preset.isMobile, maxTouchPoints: 1 }).catch(() => {});
        this.touchMode = preset.isMobile;
      } catch { /* DevTools may temporarily own the debugger. */ }
    }
  }

  setBounds(bounds: PortalViewBounds): void {
    if (this.isDestroyed) return;
    if (Object.keys(bounds).every((key) => bounds[key as keyof PortalViewBounds] === this.currentBounds[key as keyof PortalViewBounds])) return;
    const resized = bounds.width !== this.currentBounds.width || bounds.height !== this.currentBounds.height;
    this.currentBounds = bounds;
    this.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });
    if (resized && this.readyForEmulation && this.emulation?.preset.isMobile) this.applyEmulation(this.emulation.preset, this.emulation.orientation);
  }

  setVisible(visible: boolean): void {
    if (this.isDestroyed) return;
    this.view.setVisible(visible);
  }

  getBounds(): PortalViewBounds {
    return this.currentBounds;
  }

  getUrl(): string {
    return this.currentUrl;
  }

  getTitle(): string {
    return this.currentTitle;
  }

  getFavicon(): string | undefined {
    return this.currentFavicon;
  }

  isLoading(): boolean {
    return !this.isDestroyed && this.view.webContents.isLoading();
  }

  canGoBack(): boolean {
    return !this.isDestroyed && this.view.webContents.canGoBack();
  }

  canGoForward(): boolean {
    return !this.isDestroyed && this.view.webContents.canGoForward();
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    try {
      this.view.webContents.stop();
      this.view.setVisible(false);
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close();
      }
    } catch {
      // Ignora erro se já estiver encerrada
    }
  }
}
