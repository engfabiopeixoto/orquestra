export const QUALITY_MIN_WIDTH = 260;
export const QUALITY_DEFAULT_WIDTH = 320;
export const QUALITY_MAX_WIDTH_RATIO = 0.5;

export const PROJECTS_MIN_HEIGHT = 48;
export const EXPLORER_MIN_HEIGHT = 120;
export const PROJECTS_DEFAULT_HEIGHT = 180;

export type QualityDrawerPrefs = { open: boolean; width: number };

const QUALITY_PREF_PREFIX = 'orq:quality-drawer:';
const PROJECTS_HEIGHT_KEY = 'orq:sidebar:projects-height';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), Math.round(value)));
}

/** Limita a largura do painel de Qualidade entre 260 px e 50% da janela. */
export function clampQualityWidth(width: number, viewportWidth: number): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const maxWidth = Math.max(QUALITY_MIN_WIDTH, Math.floor(safeViewport * QUALITY_MAX_WIDTH_RATIO));
  return clamp(Number.isFinite(width) ? width : QUALITY_DEFAULT_WIDTH, QUALITY_MIN_WIDTH, maxWidth);
}

/** Limita a altura da lista de projetos preservando ao menos 120 px para o explorador. */
export function clampProjectsHeight(height: number, availableHeight: number): number {
  const max = Math.max(PROJECTS_MIN_HEIGHT, Math.floor(availableHeight - EXPLORER_MIN_HEIGHT));
  return clamp(Number.isFinite(height) ? height : PROJECTS_DEFAULT_HEIGHT, PROJECTS_MIN_HEIGHT, max);
}

function qualityStorageKey(workspaceKey: string): string {
  return `${QUALITY_PREF_PREFIX}${encodeURIComponent((workspaceKey || 'default').replace(/\\/g, '/').toLowerCase())}`;
}

export function readQualityDrawerPrefs(workspaceKey: string): QualityDrawerPrefs {
  const defaults: QualityDrawerPrefs = { open: false, width: QUALITY_DEFAULT_WIDTH };
  try {
    const raw = localStorage.getItem(qualityStorageKey(workspaceKey));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<QualityDrawerPrefs> | null;
    if (!parsed || typeof parsed !== 'object') return defaults;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : false,
      width: typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.max(QUALITY_MIN_WIDTH, Math.round(parsed.width))
        : QUALITY_DEFAULT_WIDTH,
    };
  } catch {
    return defaults;
  }
}

export function writeQualityDrawerPrefs(workspaceKey: string, prefs: QualityDrawerPrefs): void {
  try {
    localStorage.setItem(
      qualityStorageKey(workspaceKey),
      JSON.stringify({ open: Boolean(prefs.open), width: Math.max(QUALITY_MIN_WIDTH, Math.round(prefs.width)) }),
    );
  } catch {
    // Ignora falha de acesso/quota no localStorage.
  }
}

export function readProjectsHeight(): number | null {
  try {
    const raw = localStorage.getItem(PROJECTS_HEIGHT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  } catch {
    return null;
  }
}

export function writeProjectsHeight(height: number | null): void {
  try {
    if (height === null) localStorage.removeItem(PROJECTS_HEIGHT_KEY);
    else localStorage.setItem(PROJECTS_HEIGHT_KEY, String(Math.max(PROJECTS_MIN_HEIGHT, Math.round(height))));
  } catch {
    // Ignora falha de acesso/quota no localStorage.
  }
}
