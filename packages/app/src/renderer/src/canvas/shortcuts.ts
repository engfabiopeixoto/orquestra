export type CanvasShortcut = 'zoom-reset' | 'fit';

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
