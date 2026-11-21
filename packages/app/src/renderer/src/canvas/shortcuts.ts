export type CanvasShortcut = 'zoom-reset' | 'fit';
export const QUALITY_SHORTCUT_HINT = 'Ctrl+Shift+Q';

type ShortcutKeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  getModifierState?(keyArg: string): boolean;
  target?: EventTarget | null;
};

function isEditableElement(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return typeof el.closest === 'function' && Boolean(el.closest('[contenteditable="true"], [contenteditable=""]'));
}

/** Atalhos do canvas. Com um terminal focado em zoom 100%, toda tecla é do agente (spec, seção 4). */
export function canvasShortcut(
  event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  context: { terminalFocused: boolean; isFullZoom: boolean },
): CanvasShortcut | null {
  const capturing = context.terminalFocused && context.isFullZoom;
  if (capturing || !event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (event.key === '0') return 'zoom-reset';
  if (event.key === '1') return 'fit';
  return null;
}

/** Atalho global para recolher/abrir o painel de Qualidade (ignora AltGr ABNT2, campos editáveis e terminal a 100%). */
export function isQualityToggleShortcut(
  event: ShortcutKeyEvent,
  context: { terminalFocused: boolean; isFullZoom: boolean },
): boolean {
  const capturing = context.terminalFocused && context.isFullZoom;
  if (capturing) return false;
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return false;
  if (event.getModifierState?.('AltGraph')) return false;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (isEditableElement(event.target) || isEditableElement(active)) return false;
  return event.code === 'KeyQ';
}
