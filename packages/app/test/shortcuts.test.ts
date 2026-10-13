import { describe, expect, it } from 'vitest';
import { canvasShortcut } from '../src/renderer/src/canvas/shortcuts';

const key = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
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
});
