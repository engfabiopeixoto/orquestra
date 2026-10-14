// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { forwardWheelToTerminal } from '../src/renderer/src/terminal/wheel';

const wheel = (init: WheelEventInit = {}) => new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, clientX: 40, clientY: 25, bubbles: true, cancelable: true, ...init });
const setup = () => {
  const xterm = document.createElement('div');
  const term = { options: { disableStdin: true } };
  const received: Array<{ deltaY: number; deltaMode: number; clientX: number; clientY: number; stdinDisabled: boolean; bubbles: boolean }> = [];
  xterm.addEventListener('wheel', (event) => {
    const { deltaY, deltaMode, clientX, clientY, bubbles } = event as WheelEvent;
    received.push({ deltaY, deltaMode, clientX, clientY, bubbles, stdinDisabled: term.options.disableStdin });
  });
  return { xterm, term, received };
};

describe('forwardWheelToTerminal', () => {
  it('entrega ao xterm uma roda com os mesmos deslocamentos e posição, com a entrada liberada só durante o envio', () => {
    const { xterm, term, received } = setup();
    const handled = forwardWheelToTerminal(term, xterm, wheel({ deltaY: -240, deltaMode: 1 }));
    expect(handled).toBe(true);
    expect(received).toEqual([{ deltaY: -240, deltaMode: 1, clientX: 40, clientY: 25, bubbles: false, stdinDisabled: false }]);
    expect(term.options.disableStdin).toBe(true);
  });

  it('restaura a entrada mesmo se o xterm lançar durante o envio', () => {
    const { xterm, term } = setup();
    xterm.addEventListener('wheel', () => { throw new Error('falha no xterm'); });
    // O jsdom relata a exceção do ouvinte como erro da janela: aqui ela é esperada.
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', swallow);
    forwardWheelToTerminal(term, xterm, wheel());
    window.removeEventListener('error', swallow);
    expect(term.options.disableStdin).toBe(true);
  });

  it('para a propagação e impede o padrão, para o canvas não receber a mesma roda', () => {
    const { xterm, term } = setup();
    const original = wheel();
    const stop = vi.spyOn(original, 'stopPropagation');
    forwardWheelToTerminal(term, xterm, original);
    expect(stop).toHaveBeenCalled();
    expect(original.defaultPrevented).toBe(true);
  });

  it('deixa Ctrl e Meta com o canvas (zoom) e não faz nada sem o elemento do xterm', () => {
    const { xterm, term, received } = setup();
    const ctrl = wheel({ ctrlKey: true });
    expect(forwardWheelToTerminal(term, xterm, ctrl)).toBe(false);
    expect(forwardWheelToTerminal(term, xterm, wheel({ metaKey: true }))).toBe(false);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(received).toEqual([]);
    expect(forwardWheelToTerminal(term, null, wheel())).toBe(false);
  });
});
