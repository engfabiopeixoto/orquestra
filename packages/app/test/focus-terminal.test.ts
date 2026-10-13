import { describe, expect, it, vi } from 'vitest';
import { focusTerminalRequest } from '../src/renderer/src/canvas/focus-terminal';

describe('focusTerminalRequest', () => {
  it('centraliza o terminal a 100% e marca o foco', () => {
    const setCenter = vi.fn();
    const setFocus = vi.fn();
    const ok = focusTerminalRequest('A', {
      getNode: () => ({ position: { x: 100, y: 50 }, measured: { width: 600, height: 400 } }),
      setCenter,
      setFocus,
      sizeOf: () => ({ width: 640, height: 400 }),
    });
    expect(ok).toBe(true);
    expect(setFocus).toHaveBeenCalledWith('A');
    expect(setCenter).toHaveBeenCalledWith(400, 250, { zoom: 1, duration: 200 });
  });

  it('pedido de foco para terminal inexistente não faz nada', () => {
    const setCenter = vi.fn();
    const setFocus = vi.fn();
    expect(focusTerminalRequest('X', { getNode: () => undefined, setCenter, setFocus, sizeOf: () => undefined })).toBe(false);
    expect(setCenter).not.toHaveBeenCalled();
    expect(setFocus).not.toHaveBeenCalled();
  });
});
