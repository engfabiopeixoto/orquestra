import { describe, expect, it } from 'vitest';
import { encodeWin32KeyEvent, installCodexInputMode } from '../src/renderer/src/terminal/codex-input';

describe('entrada do Codex em ConPTY', () => {
  it('codifica Ctrl+S como registro Win32 com virtual key e modificador', () => {
    expect(encodeWin32KeyEvent({ code: 'KeyS', key: 's', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, true))
      .toBe('\x1b[83;31;19;1;8;1_');
  });

  it('preserva Shift+Enter, incluindo o keydown e o keyup', () => {
    const event = { code: 'Enter', key: 'Enter', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false };
    expect(encodeWin32KeyEvent(event, true)).toBe('\x1b[13;28;13;1;16;1_');
    expect(encodeWin32KeyEvent(event, false)).toBe('\x1b[13;28;13;0;16;1_');
  });

  it('detecta modo Win32 e impede mouse tracking de desativar a seleção do xterm', () => {
    const handlers = new Map<string, (params: (number | number[])[]) => boolean>();
    const parser = { registerCsiHandler: (id: { prefix?: string; final: string }, handler: (params: (number | number[])[]) => boolean) => {
      handlers.set(`${id.prefix ?? ''}${id.final}`, handler);
      return { dispose() {} };
    } };
    const mode = { win32Input: false };
    installCodexInputMode(parser, mode);

    expect(handlers.get('?h')!([9001])).toBe(false);
    expect(mode.win32Input).toBe(true);
    expect(handlers.get('?h')!([1003, 1006])).toBe(true);
    expect(handlers.get('?l')!([1003, 1006])).toBe(true);
    expect(handlers.get('?h')!([2004])).toBe(false);
    expect(handlers.get('?l')!([9001])).toBe(false);
    expect(mode.win32Input).toBe(false);
  });
});
