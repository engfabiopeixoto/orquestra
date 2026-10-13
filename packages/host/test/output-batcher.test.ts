import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputBatcher } from '../src/output-batcher.js';

describe('OutputBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('junta a saída de cada terminal e envia uma vez por intervalo', () => {
    const sent: Array<[string, string]> = [];
    const batcher = new OutputBatcher((name, data) => sent.push([name, data]), 16);
    batcher.push('A', 'o');
    batcher.push('A', 'lá');
    batcher.push('B', 'x');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([['A', 'olá'], ['B', 'x']]);
  });

  it('drop descarta a saída pendente de um terminal removido', () => {
    const sent: Array<[string, string]> = [];
    const batcher = new OutputBatcher((name, data) => sent.push([name, data]), 16);
    batcher.push('A', 'perdido');
    batcher.drop('A');
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([]);
  });
});
