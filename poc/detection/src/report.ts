import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT, type RunResult } from './run-session.js';

export function summarize(results: RunResult[]) {
  return {
    total: results.length,
    hookOk: results.filter((item) => item.correct && item.clean).length,
    heuristicOk: results.filter((item) => item.heuristicCorrect).length,
    bySource: {
      hook: results.filter((item) => item.source === 'hook').length,
      transcript: results.filter((item) => item.source === 'transcript').length,
      none: results.filter((item) => item.source === 'none').length,
    },
    failures: results.filter((item) => !(item.correct && item.clean)).map((item) => item.scenarioId),
  };
}

if (process.argv[1]?.endsWith('report.ts')) {
  for (const run of readdirSync(RUNS_ROOT).sort()) {
    const resultsPath = join(RUNS_ROOT, run, 'results.jsonl');
    if (!existsSync(resultsPath)) continue;
    const lines = readFileSync(resultsPath, 'utf8').trim().split('\n');
    const summary = summarize(lines.filter(Boolean).map((line) => JSON.parse(line) as RunResult));
    console.log(
      `${run}: hooks ${summary.hookOk}/${summary.total}, heurística ${summary.heuristicOk}/${summary.total}, falhas: ${summary.failures.join(', ') || 'nenhuma'}`,
    );
  }
}
