import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newLinesSince, SilenceDetector } from '../src/heuristic.js';

describe('SilenceDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispara após o silêncio que segue alguma saída', () => {
    const onQuiet = vi.fn();
    const detector = new SilenceDetector({ quietMs: 1000, onQuiet });
    detector.arm();
    vi.advanceTimersByTime(5000);
    expect(onQuiet).not.toHaveBeenCalled();
    detector.feed();
    vi.advanceTimersByTime(900);
    detector.feed();
    vi.advanceTimersByTime(900);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('dispara uma vez por arm e ignora saída quando desarmado', () => {
    const onQuiet = vi.fn();
    const detector = new SilenceDetector({ quietMs: 100, onQuiet });
    detector.feed();
    vi.advanceTimersByTime(500);
    expect(onQuiet).not.toHaveBeenCalled();
    detector.arm();
    detector.feed();
    vi.advanceTimersByTime(100);
    detector.feed();
    vi.advanceTimersByTime(100);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });
});

describe('newLinesSince', () => {
  it('extrai só as linhas novas, sem o eco do prompt', () => {
    const before = 'cabeçalho\n> ';
    const after = 'cabeçalho\n> Quanto é 2+2?\n\n4\n\n> ';
    expect(newLinesSince(before, after, 'Quanto é 2+2?')).toBe('4');
  });
});
