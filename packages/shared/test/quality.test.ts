import { describe, expect, it } from 'vitest';
import {
  QUALITY_GUIDE,
  QUALITY_LIMITS,
  QUALITY_METRICS,
  formatQualityExplain,
  formatQualitySummary,
  isMethodName,
  parseParams,
  qualityAgentPrompt,
  qualityReportSchema,
  signalFor,
  type QualityReport,
} from '../src/index.js';

function makeFixtureReport(overrides: Partial<QualityReport> = {}): QualityReport {
  return {
    version: 1,
    dir: 'E:/proj/demo',
    measuredAt: '2026-11-20T12:00:00.000Z',
    durationMs: 120,
    language: 'js-ts',
    limits: { files: 12, skippedLarge: 0, truncated: false },
    metrics: [
      { id: 'size', signal: 'bad', value: 700, delta: 100 },
      { id: 'complexity', signal: 'warn', value: 14, delta: null },
      { id: 'dependencies', signal: 'ok', value: 0, delta: 0 },
      { id: 'coverage', signal: 'warn', value: 65, delta: 5 },
      { id: 'mutation', signal: 'missing', value: null, delta: null },
    ],
    files: [
      {
        path: 'src/big.ts',
        loc: 700,
        test: false,
        functions: 4,
        maxComplexity: 14,
        sumComplexity: 28,
        maxDepth: 3,
        fanIn: 1,
        fanOut: 2,
        commits90d: 8,
      },
    ],
    functions: [
      { path: 'src/big.ts', line: 10, name: 'render', complexity: 14, depth: 3, loc: 90 },
    ],
    cycles: [],
    hotspots: [
      {
        path: 'src/big.ts',
        score: 1568,
        reason: '700 linhas, função render com complexidade 14, alterado 8 vezes em 90 dias',
      },
    ],
    changed: [
      {
        path: 'src/big.ts',
        kind: 'file-over-limit',
        detail: 'Passou de 350 linhas (700 linhas).',
      },
    ],
    coverage: {
      source: 'summary',
      generatedAt: '2026-11-20T11:50:00.000Z',
      stale: false,
      lines: 65,
      branches: 60,
      functions: 70,
      files: [{ path: 'src/big.ts', lines: 65, uncovered: 35 }],
    },
    mutation: null,
    ...overrides,
  };
}

describe('contrato, limites e guia de qualidade (shared)', () => {
  it('signalFor calcula os sinais conforme QUALITY_LIMITS e extras', () => {
    expect(signalFor('size', 351)).toBe('warn');
    expect(signalFor('size', 601)).toBe('bad');
    expect(signalFor('size', 350)).toBe('ok');

    expect(signalFor('complexity', 21)).toBe('bad');
    expect(signalFor('complexity', 8, { maxDepth: 5 })).toBe('warn');

    expect(signalFor('coverage', 69.9)).toBe('warn');
    expect(signalFor('coverage', 49)).toBe('bad');

    expect(signalFor('mutation', 80)).toBe('ok');
    expect(signalFor('mutation', null)).toBe('missing');

    expect(signalFor('dependencies', 0, { typeOnlyCycles: 1 })).toBe('warn');
    expect(signalFor('dependencies', 1)).toBe('bad');
  });

  it('qualityAgentPrompt gera uma linha sem quebra e cita arquivo alterado na mutação', () => {
    const report = makeFixtureReport();
    const covPrompt = qualityAgentPrompt('coverage', report);
    const mutPrompt = qualityAgentPrompt('mutation', report);

    expect(covPrompt).not.toContain('\n');
    expect(covPrompt).not.toContain('\r');
    expect(covPrompt).toContain('json-summary');
    expect(covPrompt).toContain('coverage/');

    expect(mutPrompt).not.toContain('\n');
    expect(mutPrompt).not.toContain('\r');
    expect(mutPrompt).toContain('src/big.ts');
    expect(mutPrompt).toContain('reports/mutation/mutation.json');
  });

  it('QUALITY_GUIDE referencia os números de QUALITY_LIMITS na explicação dos limites', () => {
    for (const id of QUALITY_METRICS) {
      expect(QUALITY_GUIDE[id].title.length).toBeGreaterThan(0);
      expect(QUALITY_GUIDE[id].what.length).toBeGreaterThan(0);
      expect(QUALITY_GUIDE[id].why.length).toBeGreaterThan(0);
      expect(QUALITY_GUIDE[id].improve.length).toBeGreaterThan(0);
    }

    expect(QUALITY_GUIDE.size.limits).toContain(String(QUALITY_LIMITS.fileLoc.warn));
    expect(QUALITY_GUIDE.size.limits).toContain(String(QUALITY_LIMITS.fileLoc.bad));
    expect(QUALITY_GUIDE.complexity.limits).toContain(String(QUALITY_LIMITS.complexity.warn));
    expect(QUALITY_GUIDE.complexity.limits).toContain(String(QUALITY_LIMITS.complexity.bad));
    expect(QUALITY_GUIDE.complexity.limits).toContain(String(QUALITY_LIMITS.depth.warn));
    expect(QUALITY_GUIDE.dependencies.limits.length).toBeGreaterThan(0);
    expect(QUALITY_GUIDE.coverage.limits).toContain(String(QUALITY_LIMITS.coverageLines.warn));
    expect(QUALITY_GUIDE.coverage.limits).toContain(String(QUALITY_LIMITS.coverageLines.bad));
    expect(QUALITY_GUIDE.mutation.limits).toContain(String(QUALITY_LIMITS.mutationScore.warn));
    expect(QUALITY_GUIDE.mutation.limits).toContain(String(QUALITY_LIMITS.mutationScore.bad));
  });

  it('formatQualitySummary mostra PROBLEMA para arquivo de 700 linhas e sem undefined', () => {
    const report = makeFixtureReport();
    const summary = formatQualitySummary(report, { changed: false });

    expect(summary).toContain('PROBLEMA');
    expect(summary).toContain('700');
    expect(summary).toContain('orq quality --explain');
    expect(summary).not.toContain('undefined');

    const changedSummary = formatQualitySummary(report, { changed: true });
    expect(changedSummary).toContain('src/big.ts');
    expect(changedSummary).not.toContain('undefined');
  });

  it('formatQualityExplain formata o guia completo da métrica', () => {
    const text = formatQualityExplain('coverage');
    expect(text).toContain(QUALITY_GUIDE.coverage.title);
    expect(text).toContain(QUALITY_GUIDE.coverage.what);
    expect(text).toContain(QUALITY_GUIDE.coverage.limits);
    expect(text).not.toContain('undefined');
  });

  it('qualityReportSchema e protocolo aceitam o fixture e o método quality', () => {
    const report = makeFixtureReport();
    expect(qualityReportSchema.parse(report)).toEqual(report);
    expect(isMethodName('quality')).toBe(true);
    expect(parseParams('quality', { changed: true })).toEqual({ changed: true });
  });
});
