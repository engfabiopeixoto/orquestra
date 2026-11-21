// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { canvasShortcut, isQualityToggleShortcut, QUALITY_SHORTCUT_HINT } from '../src/renderer/src/canvas/shortcuts';

const key = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string; altGraph: boolean; target: EventTarget | null }> = {},
) => ({
  key,
  code: mods.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined),
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  target: mods.target ?? null,
  getModifierState: (mod: string) => mod === 'AltGraph' && Boolean(mods.altGraph),
  ...mods,
});

describe('canvasShortcut', () => {
  it('Ctrl+0 volta a 100% e Ctrl+1 ajusta tudo', () => {
    expect(canvasShortcut(key('0', { ctrlKey: true }), { terminalFocused: false, isFullZoom: true })).toBe('zoom-reset');
    expect(canvasShortcut(key('1', { ctrlKey: true }), { terminalFocused: false, isFullZoom: true })).toBe('fit');
  });

  it('com terminal focado, nenhum atalho do canvas é acionado', () => {
    for (const event of [key('0', { ctrlKey: true }), key('1', { ctrlKey: true }), key('Delete')]) {
      expect(canvasShortcut(event, { terminalFocused: true, isFullZoom: true })).toBeNull();
    }
  });

  it('teclas sem Ctrl ou com Shift não são atalhos', () => {
    expect(canvasShortcut(key('0'), { terminalFocused: false, isFullZoom: true })).toBeNull();
    expect(canvasShortcut(key('0', { ctrlKey: true, shiftKey: true }), { terminalFocused: false, isFullZoom: true })).toBeNull();
  });

  it('com zoom diferente de 100%, terminal focado não bloqueia atalhos do canvas', () => {
    expect(canvasShortcut(key('0', { ctrlKey: true }), { terminalFocused: true, isFullZoom: false })).toBe('zoom-reset');
    expect(canvasShortcut(key('1', { ctrlKey: true }), { terminalFocused: true, isFullZoom: false })).toBe('fit');
  });

  it('Ctrl+Shift+Q alterna painel de Qualidade por code KeyQ, ignora ABNT2 AltGr+Q e campos editáveis', () => {
    expect(QUALITY_SHORTCUT_HINT).toBe('Ctrl+Shift+Q');
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, code: 'KeyQ' }), { terminalFocused: false, isFullZoom: true })).toBe(true);
    expect(isQualityToggleShortcut(key('q', { ctrlKey: true, shiftKey: true, code: 'KeyQ' }), { terminalFocused: true, isFullZoom: false })).toBe(true);
    expect(isQualityToggleShortcut(key('q', { ctrlKey: true, shiftKey: true, code: 'KeyQ' }), { terminalFocused: true, isFullZoom: true })).toBe(false);
    // ABNT2 AltGr+Q envia ctrlKey + altKey + code KeyQ + key '/'
    expect(isQualityToggleShortcut(key('/', { ctrlKey: true, altKey: true, code: 'KeyQ' }), { terminalFocused: false, isFullZoom: true })).toBe(false);
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, code: 'KeyQ', altGraph: true }), { terminalFocused: false, isFullZoom: true })).toBe(false);
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, metaKey: true, code: 'KeyQ' }), { terminalFocused: false, isFullZoom: true })).toBe(false);
    expect(isQualityToggleShortcut(key('q', { ctrlKey: true, code: 'KeyQ' }), { terminalFocused: false, isFullZoom: true })).toBe(false);
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, code: 'KeyP' }), { terminalFocused: false, isFullZoom: true })).toBe(false);

    const input = document.createElement('input');
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, code: 'KeyQ', target: input }), { terminalFocused: false, isFullZoom: true })).toBe(false);
    const textarea = document.createElement('textarea');
    expect(isQualityToggleShortcut(key('Q', { ctrlKey: true, shiftKey: true, code: 'KeyQ', target: textarea }), { terminalFocused: false, isFullZoom: true })).toBe(false);
  });
});
