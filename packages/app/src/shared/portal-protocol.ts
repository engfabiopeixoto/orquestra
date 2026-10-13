export interface DevicePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  userAgent: string;
  hasTouch: boolean;
}

export type PortalOrientation = 'portrait' | 'landscape';
export type PortalMode = 'desktop' | 'mobile';

export const DESKTOP_PRESETS: DevicePreset[] = [
  {
    id: 'desktop-compact',
    name: 'Desktop (Padrão)',
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    isMobile: false,
    userAgent: '',
    hasTouch: false,
  },
  {
    id: 'desktop-hd',
    name: 'Desktop HD (1280x720)',
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    isMobile: false,
    userAgent: '',
    hasTouch: false,
  },
];

export const MOBILE_PRESETS: DevicePreset[] = [
  {
    id: 'iphone-15-pro',
    name: 'iPhone 15 Pro (393x852)',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  },
  {
    id: 'iphone-se',
    name: 'iPhone SE (375x667)',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  },
  {
    id: 'pixel-7',
    name: 'Google Pixel 7 (412x915)',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    hasTouch: true,
  },
  {
    id: 'galaxy-s23',
    name: 'Samsung Galaxy S23 (360x780)',
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    hasTouch: true,
  },
  {
    id: 'ipad-mini',
    name: 'iPad Mini (744x1133)',
    width: 744,
    height: 1133,
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  },
];

export const ALL_PRESETS = [...DESKTOP_PRESETS, ...MOBILE_PRESETS];

export function getDevicePreset(id: string): DevicePreset {
  const found = ALL_PRESETS.find((p) => p.id === id);
  return found ?? MOBILE_PRESETS[0]!;
}

export function rotateDimensions(
  width: number,
  height: number,
  orientation: PortalOrientation,
): { width: number; height: number } {
  if (orientation === 'landscape') {
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  }
  return {
    width: Math.min(width, height),
    height: Math.max(width, height),
  };
}

export const MAX_PORTALS_PER_WORKSPACE = 2;
export const MAX_TABS_PER_PORTAL = 3;

export function normalizePortalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'about:blank') return 'about:blank';
  // Bloqueia expressamente protocolos inseguros ou não permitidos
  if (/^(file|javascript|data|blob|vbscript):/i.test(trimmed)) return 'about:blank';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return trimmed;
      return 'about:blank';
    } catch {
      return 'about:blank';
    }
  }
  if (/^localhost(:\d+)?/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/i.test(trimmed)) return `http://${trimmed}`;
  // Se contiver qualquer outro esquema de protocolo (ex: chrome://, ftp://), bloqueia
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return 'about:blank';
  return `https://${trimmed}`;
}

export interface PortalTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PortalViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortalState {
  id: string;
  workspaceId: string;
  activeTabId: string;
  tabs: PortalTab[];
  mode: PortalMode;
  presetId: string;
  orientation: PortalOrientation;
  zoomLevel: number;
  isAttached: boolean;
  visible: boolean;
  bounds?: PortalViewBounds;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

export type PortalNavigationAction = 'back' | 'forward' | 'reload' | 'stop';

export interface PortalCreateOptions {
  portalId: string;
  workspaceId: string;
  initialUrl?: string;
  mode?: PortalMode;
  presetId?: string;
  orientation?: PortalOrientation;
  bounds?: PortalViewBounds;
  position?: { x: number; y: number };
  tabs?: PortalTab[];
  activeTabId?: string;
}

export interface PortalSyncBoundsPayload {
  portalId: string;
  workspaceId: string;
  bounds: PortalViewBounds;
  visible: boolean;
  clippedByModal?: boolean;
}

export type PortalEvent =
  | { type: 'portal:loading'; portalId: string; tabId: string; isLoading: boolean }
  | { type: 'portal:navigated'; portalId: string; tabId: string; url: string; canGoBack: boolean; canGoForward: boolean }
  | { type: 'portal:title'; portalId: string; tabId: string; title: string }
  | { type: 'portal:favicon'; portalId: string; tabId: string; favicon: string }
  | { type: 'portal:error'; portalId: string; tabId: string; error: string };

export const PORTAL_IPC = {
  CREATE: 'orq:portal:create',
  NAVIGATE: 'orq:portal:navigate',
  ACTION: 'orq:portal:action',
  SYNC_BOUNDS: 'orq:portal:sync-bounds',
  SET_MODE: 'orq:portal:set-mode',
  CREATE_TAB: 'orq:portal:create-tab',
  SWITCH_TAB: 'orq:portal:switch-tab',
  CLOSE_TAB: 'orq:portal:close-tab',
  DESTROY: 'orq:portal:destroy',
  SET_ACTIVE_WORKSPACE: 'orq:portal:set-active-workspace',
  SET_MODAL_STATE: 'orq:portal:set-modal-state',
  GET_STATE: 'orq:portal:get-state',
  EVENT: 'orq:portal:event',
} as const;
