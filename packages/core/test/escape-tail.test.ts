import { describe, expect, it } from 'vitest';
import { incompleteEscapeTail } from '../src/escape-tail.js';

const ESC = '\x1b';

describe('incompleteEscapeTail', () => {
  it('sem escape aberto no fim, não há resto', () => {
    expect(incompleteEscapeTail('texto')).toBe('');
    expect(incompleteEscapeTail(`${ESC}[31mvermelho${ESC}[0m`)).toBe('');
    expect(incompleteEscapeTail(`${ESC}]0;título\x07fim`)).toBe('');
    expect(incompleteEscapeTail(`${ESC}]8;;url${ESC}\\link`)).toBe('');
    expect(incompleteEscapeTail(`${ESC}7`)).toBe('');
  });

  it('CSI cortado antes do byte final é devolvido (o d de VPA chegaria sozinho na interface)', () => {
    expect(incompleteEscapeTail(`antes${ESC}[5`)).toBe(`${ESC}[5`);
    expect(incompleteEscapeTail(`x${ESC}[?2026$`)).toBe(`${ESC}[?2026$`);
    expect(incompleteEscapeTail(`x${ESC}[`)).toBe(`${ESC}[`);
    expect(incompleteEscapeTail(`x${ESC}`)).toBe(ESC);
  });

  it('OSC e DCS sem terminador são devolvidos', () => {
    expect(incompleteEscapeTail(`x${ESC}]0;meu tít`)).toBe(`${ESC}]0;meu tít`);
    expect(incompleteEscapeTail(`x${ESC}P1$r`)).toBe(`${ESC}P1$r`);
    expect(incompleteEscapeTail(`x${ESC}]0;t${ESC}`)).toBe(`${ESC}]0;t${ESC}`);
  });

  it('ESC com intermediário sem final é devolvido', () => {
    expect(incompleteEscapeTail(`x${ESC}(`)).toBe(`${ESC}(`);
    expect(incompleteEscapeTail(`x${ESC}(B`)).toBe('');
  });
});
