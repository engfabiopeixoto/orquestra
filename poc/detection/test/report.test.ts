import { describe, expect, it } from 'vitest';
import { summarize } from '../src/report.js';
import type { RunResult } from '../src/run-session.js';

const result = (overrides: Partial<RunResult>): RunResult => ({
  scenarioId: 'x',
  correct: true,
  clean: true,
  source: 'hook',
  answer: 'ok',
  heuristicAnswer: 'ok',
  heuristicCorrect: true,
  durationMs: 1,
  heuristicDeltaMs: 1,
  waitingUserEvents: 0,
  ...overrides,
});

describe('summarize', () => {
  it('conta acertos de hook, de heurística e por fonte', () => {
    const summary = summarize([
      result({}),
      result({ scenarioId: 'y', clean: false, heuristicCorrect: false }),
      result({ scenarioId: 'z', correct: false, source: 'none', answer: null }),
    ]);
    expect(summary).toEqual({
      total: 3,
      hookOk: 1,
      heuristicOk: 2,
      bySource: { hook: 2, transcript: 0, none: 1 },
      failures: ['y', 'z'],
    });
  });
});
