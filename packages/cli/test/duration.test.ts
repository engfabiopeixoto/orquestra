import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/duration.js';

describe('parseDuration', () => {
  it('entende minutos, segundos, milissegundos e número puro em segundos', () => {
    expect(parseDuration('8m')).toBe(480_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90')).toBe(90_000);
  });

  it('recusa formato inválido com USAGE', () => {
    expect(() => parseDuration('dez')).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
});
