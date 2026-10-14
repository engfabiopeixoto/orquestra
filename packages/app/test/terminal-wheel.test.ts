// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { applyWheelScroll, forwardWheelToCanvas, forwardWheelToTerminal, wheelToLines } from '../src/renderer/src/terminal/wheel';

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

describe('wheelToLines', () => {
  it('converte pixels em linhas acumulando a fração entre eventos', () => {
    const first = wheelToLines({ deltaY: -400, deltaMode: 0 }, 15, 24, 0);
    expect(first.lines).toBe(-26);
    const second = wheelToLines({ deltaY: -10, deltaMode: 0 }, 15, 24, first.carry);
    expect(second.lines).toBe(-1);
    expect(wheelToLines({ deltaY: 5, deltaMode: 0 }, 15, 24, 0)).toEqual({ lines: 0, carry: 5 / 15 });
  });

  it('entende deltaMode de linhas e de páginas', () => {
    expect(wheelToLines({ deltaY: -3, deltaMode: 1 }, 15, 24, 0).lines).toBe(-3);
    expect(wheelToLines({ deltaY: 1, deltaMode: 2 }, 15, 24, 0).lines).toBe(24);
  });
});

describe('applyWheelScroll', () => {
  const termWith = (overrides: { type?: string; mouse?: string } = {}) => ({
    rows: 24,
    buffer: { active: { type: overrides.type ?? 'normal' } },
    modes: { mouseTrackingMode: overrides.mouse ?? 'none' },
    scrollLines: vi.fn(),
  });

  it('rola o buffer direto, sem depender do scrollTop do DOM, e consome o evento', () => {
    const term = termWith();
    const state = { carry: 0 };
    const event = wheel({ deltaY: -300 });
    expect(applyWheelScroll(term, event, 15, state)).toBe(true);
    expect(term.scrollLines).toHaveBeenCalledWith(-20);
    expect(event.defaultPrevented).toBe(true);
  });

  it('não interfere em tela alternativa nem com mouse tracking: a TUI recebe a roda pelo xterm', () => {
    for (const term of [termWith({ type: 'alternate' }), termWith({ mouse: 'any' })]) {
      const event = wheel();
      expect(applyWheelScroll(term, event, 15, { carry: 0 })).toBe(false);
      expect(term.scrollLines).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('deixa Ctrl e Meta (zoom) e altura de célula desconhecida para o comportamento padrão', () => {
    const term = termWith();
    expect(applyWheelScroll(term, wheel({ ctrlKey: true }), 15, { carry: 0 })).toBe(false);
    expect(applyWheelScroll(term, wheel({ metaKey: true }), 15, { carry: 0 })).toBe(false);
    expect(applyWheelScroll(term, wheel(), 0, { carry: 0 })).toBe(false);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('um deslocamento menor que uma linha é consumido e fica acumulado', () => {
    const term = termWith();
    const state = { carry: 0 };
    expect(applyWheelScroll(term, wheel({ deltaY: 6 }), 15, state)).toBe(true);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(applyWheelScroll(term, wheel({ deltaY: 12 }), 15, state)).toBe(true);
    expect(term.scrollLines).toHaveBeenCalledWith(1);
  });
});

describe('forwardWheelToCanvas', () => {
  const setupCanvas = () => {
    const parent = document.createElement('div');
    const node = document.createElement('div');
    parent.append(node);
    const seen: Array<{ ctrlKey: boolean; metaKey: boolean; deltaY: number; deltaMode: number; clientX: number; clientY: number; cancelable: boolean; bubbles: boolean }> = [];
    parent.addEventListener('wheel', (event) => {
      const { ctrlKey, metaKey, deltaY, deltaMode, clientX, clientY, cancelable, bubbles } = event as WheelEvent;
      seen.push({ ctrlKey, metaKey, deltaY, deltaMode, clientX, clientY, cancelable, bubbles });
    });
    return { node, seen };
  };

  it('Ctrl+roda vira uma roda nova no nó, que sobe até o canvas, e o evento original é consumido', () => {
    const { node, seen } = setupCanvas();
    const original = wheel({ ctrlKey: true, deltaY: 180, deltaMode: 0 });
    const stop = vi.spyOn(original, 'stopPropagation');
    expect(forwardWheelToCanvas(original, node)).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(original.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ ctrlKey: true, metaKey: false, deltaY: 180, deltaMode: 0, clientX: 40, clientY: 25, cancelable: true, bubbles: true }]);
  });

  it('Meta também é zoom; roda sem modificador e alvo ausente não são tratados', () => {
    const { node, seen } = setupCanvas();
    expect(forwardWheelToCanvas(wheel({ metaKey: true }), node)).toBe(true);
    expect(seen).toHaveLength(1);
    const plain = wheel();
    expect(forwardWheelToCanvas(plain, node)).toBe(false);
    expect(plain.defaultPrevented).toBe(false);
    expect(forwardWheelToCanvas(wheel({ ctrlKey: true }), null)).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
