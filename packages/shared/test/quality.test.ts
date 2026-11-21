import { describe, expect, it } from 'vitest';
import {
  QUALITY_GUIDE,
  QUALITY_LIMITS,
  QUALITY_METRICS,
  changedItemRefactorTarget,
  formatQualityExplain,
  formatQualityForReview,
  formatQualitySummary,
  hasQualityRefactorTarget,
  isMethodName,
  parseHostParams,
  parseParams,
  qualityAgentPrompt,
  qualityRefactorPrompt,
  qualityReportSchema,
  resolveQualityRefactorTarget,
  worstRefactorTarget,
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

  it('formatQualityForReview mostra 5 métricas com delta, destaca itens vermelhos/alterados e limita a 40 linhas / 4 KB', () => {
    const report = makeFixtureReport();
    const review = formatQualityForReview(report);

    expect(review).toContain('PROBLEMA');
    expect(review).toContain('700 linhas (+100)');
    expect(review).toContain('65% (+5%)');
    expect(review).toContain('src/big.ts');
    expect(review).toContain('Passou de 350 linhas (700 linhas).');

    const manyChanged = Array.from({ length: 60 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: 'file-over-limit' as const,
      detail: `Arquivo ${index} passou de 350 linhas (${400 + index} linhas).`,
    }));
    const capped = formatQualityForReview(makeFixtureReport({ changed: manyChanged }));
    const lines = capped.split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(4096);
    expect(capped).toMatch(/\(mais \d+ itens; rode orq quality --changed\)/);
  });

  it('formatQualityForReview separa vermelhos novos/piorados dos já existentes, trata primeira medição e corta por 4 KB com singular/plural', () => {
    const separated = formatQualityForReview(
      makeFixtureReport({
        metrics: [
          { id: 'size', signal: 'bad', value: 700, delta: 100 },
          { id: 'complexity', signal: 'bad', value: 25, delta: 0 },
          { id: 'dependencies', signal: 'bad', value: 1, delta: 0 },
          { id: 'coverage', signal: 'bad', value: 40, delta: -5 },
          { id: 'mutation', signal: 'bad', value: 50, delta: 0 },
        ],
        changed: [{ path: 'src/cycle.ts', kind: 'new-cycle', detail: 'Ciclo novo.' }],
      }),
    );
    expect(separated).toContain('Vermelhos novos ou piorados: Tamanho dos módulos, Dependências, Cobertura de testes.');
    expect(separated).toContain('Vermelhos que já existiam: Complexidade, Teste de mutação.');

    const firstRun = formatQualityForReview(
      makeFixtureReport({
        metrics: [
          { id: 'size', signal: 'ok', value: 120, delta: null },
          { id: 'complexity', signal: 'ok', value: 5, delta: null },
          { id: 'dependencies', signal: 'ok', value: 0, delta: null },
          { id: 'coverage', signal: 'missing', value: null, delta: null },
          { id: 'mutation', signal: 'missing', value: null, delta: null },
        ],
        changed: [],
      }),
    );
    expect(firstRun).not.toContain('undefined');
    expect(firstRun).not.toContain('null');
    expect(firstRun).toContain('Nos arquivos alterados: nenhuma piora detectada.');

    const headerProbe = formatQualityForReview(makeFixtureReport({ changed: [{ path: 'a.ts', kind: 'file-over-limit', detail: 'ok' }] }));
    const baseBytes = new TextEncoder().encode(headerProbe).length;
    const itemPayload = 'x'.repeat(Math.floor((4096 - baseBytes) / 3));
    const byteCapped = formatQualityForReview(
      makeFixtureReport({
        changed: [
          { path: 'src/1.ts', kind: 'file-over-limit', detail: itemPayload },
          { path: 'src/2.ts', kind: 'file-over-limit', detail: itemPayload },
          { path: 'src/3.ts', kind: 'file-over-limit', detail: itemPayload },
        ],
      }),
    );
    expect(byteCapped.split('\n').length).toBeLessThan(15);
    expect(new TextEncoder().encode(byteCapped).length).toBeLessThanOrEqual(4096);
    expect(byteCapped).toContain('(mais 1 item; rode orq quality --changed)');
  });

  it('formatQualityForReview informa em uma linha quando language é unsupported', () => {
    const text = formatQualityForReview(makeFixtureReport({ language: 'unsupported', changed: [] }));
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('js-ts');
  });

  it('qualityRefactorPrompt gera uma linha dentro do teto de ~1200 chars com limites de QUALITY_LIMITS para função, arquivo e ciclo', () => {
    const report = makeFixtureReport({
      cycles: [{ files: ['src/a.ts', 'src/b.ts'], typeOnly: false }],
      functions: [{ path: 'src/big.ts', line: 10, name: 'render', complexity: 26, depth: 5, loc: 90 }],
    });

    const fnPrompt = qualityRefactorPrompt({ type: 'function', path: 'src/big.ts', name: 'render', line: 10 }, report);
    expect(fnPrompt).not.toContain('\n');
    expect(fnPrompt).not.toContain('\r');
    expect(fnPrompt.length).toBeLessThanOrEqual(1200);
    expect(fnPrompt).toContain('render');
    expect(fnPrompt).toContain('src/big.ts:10');
    expect(fnPrompt).toContain('26');
    expect(fnPrompt).toContain(String(QUALITY_LIMITS.complexity.bad));
    expect(fnPrompt).toContain(String(QUALITY_LIMITS.complexity.warn));
    expect(fnPrompt).toContain('caracterização');
    expect(fnPrompt).toContain('orq quality --changed --refresh');
    expect(fnPrompt).toContain('commit');

    const filePrompt = qualityRefactorPrompt({ type: 'file', path: 'src/big.ts' }, report);
    expect(filePrompt).not.toContain('\n');
    expect(filePrompt).not.toContain('\r');
    expect(filePrompt.length).toBeLessThanOrEqual(1200);
    expect(filePrompt).toContain('src/big.ts');
    expect(filePrompt).toContain('700');
    expect(filePrompt).toContain(String(QUALITY_LIMITS.fileLoc.bad));
    expect(filePrompt).toContain(String(QUALITY_LIMITS.fileLoc.warn));
    expect(filePrompt).toContain('exports');

    const longFiles = Array.from({ length: 25 }, (_, i) => `packages/modulo-muito-longo-${i}/src/arquivo-${i}.ts`);
    const cyclePrompt = qualityRefactorPrompt({ type: 'cycle', files: longFiles }, report);
    expect(cyclePrompt).not.toContain('\n');
    expect(cyclePrompt).not.toContain('\r');
    expect(cyclePrompt.length).toBeLessThanOrEqual(1200);
    expect(cyclePrompt).toContain('ciclo');
    expect(cyclePrompt).toContain('orq quality --changed --refresh');
  });

  it('quality.ask aceita coverage, mutation e os 3 alvos de refactor no protocolo do host', () => {
    expect(parseHostParams('quality.ask', { name: 'Dev', kind: 'coverage' })).toEqual({ name: 'Dev', kind: 'coverage' });
    expect(parseHostParams('quality.ask', { name: 'Dev', kind: 'mutation' })).toEqual({ name: 'Dev', kind: 'mutation' });
    expect(
      parseHostParams('quality.ask', { name: 'Dev', kind: 'refactor', target: { type: 'function', path: 'src/a.ts', name: 'fn', line: 5 } }),
    ).toEqual({ name: 'Dev', kind: 'refactor', target: { type: 'function', path: 'src/a.ts', name: 'fn', line: 5 } });
    expect(
      parseHostParams('quality.ask', { name: 'Dev', kind: 'refactor', target: { type: 'file', path: 'src/a.ts' } }),
    ).toEqual({ name: 'Dev', kind: 'refactor', target: { type: 'file', path: 'src/a.ts' } });
    expect(
      parseHostParams('quality.ask', { name: 'Dev', kind: 'refactor', target: { type: 'cycle', files: ['src/a.ts', 'src/b.ts'] } }),
    ).toEqual({ name: 'Dev', kind: 'refactor', target: { type: 'cycle', files: ['src/a.ts', 'src/b.ts'] } });

    expect(() => parseHostParams('quality.ask', { name: 'Dev', kind: 'refactor' })).toThrow();
    expect(() => parseHostParams('quality.ask', { name: 'Dev', kind: 'refactor', target: { type: 'unknown' } })).toThrow();
  });

  it('remove caracteres de controle/Unicode em singleLine, preserva REFACTOR_RULES em cortes e trata plural em ciclos', () => {
    const dirtyReport = makeFixtureReport({
      functions: [
        { path: 'src/\x1b[31mbig\t.ts', line: 10, name: 'fn\x03\n\u2028"x"', complexity: 22, depth: 3, loc: 50 },
      ],
      changed: [
        { path: 'src/a\x1b.ts\u2029\x07', kind: 'file-over-limit', detail: 'Grande' },
      ],
    });
    const refPrompt = qualityRefactorPrompt(
      { type: 'function', path: 'src/\x1b[31mbig\t.ts', name: 'fn\x03\n\u2028"x"', line: 10 },
      dirtyReport,
    );
    expect(refPrompt).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);

    const mutPrompt = qualityAgentPrompt('mutation', dirtyReport);
    expect(mutPrompt).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);

    const longCycle = Array.from({ length: 20 }, (_, i) => `packages/modulo-longo-${i}/src/arquivo-${i}.ts`);
    const cyclePrompt = qualityRefactorPrompt({ type: 'cycle', files: longCycle }, makeFixtureReport());
    expect(cyclePrompt.length).toBeLessThanOrEqual(1200);
    expect(cyclePrompt).toContain('não faça commit e entregue para revisão.');

    // Verifica plural exato (+1 arquivo vs +N arquivos)
    const almostFullFiles = Array.from({ length: 11 }, (_, i) => `packages/modulo-extenso-${String(i).padStart(2, '0')}/src/arquivo-item-${i}.ts`);
    const oneLeftPrompt = qualityRefactorPrompt({ type: 'cycle', files: almostFullFiles }, makeFixtureReport());
    if (oneLeftPrompt.includes('+1 ')) {
      expect(oneLeftPrompt).toContain('+1 arquivo)');
      expect(oneLeftPrompt).not.toContain('+1 arquivos)');
    }
  });

  it('normaliza caminhos Windows, compara ciclos como conjunto, ignora testes e prioriza depth > 4', () => {
    const report = makeFixtureReport({
      files: [
        { path: 'src/Big.ts', loc: 400, test: false, functions: 2, maxComplexity: 9, sumComplexity: 14, maxDepth: 6, fanIn: 0, fanOut: 0, commits90d: 1 },
        { path: 'src/Big.test.ts', loc: 900, test: true, functions: 1, maxComplexity: 30, sumComplexity: 30, maxDepth: 8, fanIn: 0, fanOut: 0, commits90d: 1 },
      ],
      functions: [
        { path: 'src/Big.test.ts', line: 5, name: 'testFn', complexity: 30, depth: 8, loc: 90 },
        { path: 'src/Big.ts', line: 10, name: 'okHigh', complexity: 9, depth: 1, loc: 30 },
        { path: 'src/Big.ts', line: 40, name: 'deepWarn', complexity: 5, depth: 6, loc: 40 },
        { path: 'src/Big.ts', line: 80, name: 'anon', complexity: 12, depth: 2, loc: 25 },
      ],
      cycles: [{ files: ['src/A.ts', 'src/b.ts'], typeOnly: false }],
    });

    expect(resolveQualityRefactorTarget(report, { type: 'file', path: './src\\big.ts' })).toEqual({
      type: 'file',
      path: 'src/Big.ts',
    });
    expect(resolveQualityRefactorTarget(report, { type: 'cycle', files: ['src\\b.ts', 'src/a.ts'] })).toEqual({
      type: 'cycle',
      files: ['src/A.ts', 'src/b.ts'],
    });
    expect(hasQualityRefactorTarget(report, { type: 'function', path: 'src\\big.ts', name: 'deepWarn', line: 40 })).toBe(true);
    expect(hasQualityRefactorTarget(report, { type: 'function', path: 'src/Big.ts', name: 'deepWarn', line: 99 })).toBe(false);

    // Quando nenhuma função viola complexity.warn (>10), prioriza função que viola depth (>4) frente a complexity 9 depth 1
    const depthReport = makeFixtureReport({
      files: report.files,
      functions: [
        { path: 'src/Big.test.ts', line: 5, name: 'testFn', complexity: 30, depth: 8, loc: 90 },
        { path: 'src/Big.ts', line: 10, name: 'okHigh', complexity: 9, depth: 1, loc: 30 },
        { path: 'src/Big.ts', line: 40, name: 'deepWarn', complexity: 5, depth: 6, loc: 40 },
      ],
    });
    expect(worstRefactorTarget('complexity', depthReport)?.target).toEqual({
      type: 'function',
      path: 'src/Big.ts',
      name: 'deepWarn',
      line: 40,
    });

    // Só arquivos de teste em files -> sem alvo de refatoração em size e complexity
    const onlyTestsReport = makeFixtureReport({
      files: [{ path: 'src/only.test.ts', loc: 900, test: true, functions: 1, maxComplexity: 30, sumComplexity: 30, maxDepth: 8, fanIn: 0, fanOut: 0, commits90d: 1 }],
      functions: [{ path: 'src/only.test.ts', line: 5, name: 'onlyTestFn', complexity: 30, depth: 8, loc: 90 }],
      hotspots: [],
      changed: [],
    });
    expect(worstRefactorTarget('size', onlyTestsReport)).toBeNull();
    expect(worstRefactorTarget('complexity', onlyTestsReport)).toBeNull();

    // changedItemRefactorTarget não cai para outra linha quando parsed tem { name, line }
    const changedFn = changedItemRefactorTarget(
      { path: 'src/Big.ts', kind: 'function-over-limit', detail: 'Função anon (linha 120) tem complexidade 15 (limite 10).' },
      report,
    );
    expect(changedFn?.target).toEqual({ type: 'function', path: 'src/Big.ts', name: 'anon', line: 120 });
  });
});
