import { describe, expect, it } from 'vitest';
import { hasAnsi, Screen } from '../src/screen.js';

describe('Screen', () => {
  it('devolve o texto sem ANSI e sem linhas vazias no fim', async () => {
    const screen = new Screen(40, 10);
    await screen.write('\x1b[31mvermelho\x1b[0m\r\nação\r\n');
    expect(screen.text()).toBe('vermelho\nação');
  });

  it('aplica movimentos de cursor como um terminal real', async () => {
    const screen = new Screen(40, 10);
    await screen.write('abc\x1b[2Dz');
    expect(screen.text()).toBe('azc');
  });
});

describe('hasAnsi', () => {
  it('detecta sequências CSI e OSC', () => {
    expect(hasAnsi('a\x1b[0mb')).toBe(true);
    expect(hasAnsi('a\x1b]0;título\x07b')).toBe(true);
    expect(hasAnsi('texto limpo')).toBe(false);
  });
});
