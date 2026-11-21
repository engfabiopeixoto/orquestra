import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCoverage, readMutation } from '../src/quality/reports.js';

const fixturesDir = join(import.meta.dirname, 'fixtures', 'quality');
const temps: string[] = [];

function tempProj(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orq-reports-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('readCoverage e readMutation', () => {
  it('lê coverage-summary.json casando caminhos absolutos do Windows com barras e caixa diferentes', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    copyFileSync(join(fixturesDir, 'coverage-summary.json'), join(dir, 'coverage', 'coverage-summary.json'));

    const dirSlash = dir.replaceAll('\\', '/');
    const lowerDriveDir = dirSlash.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'coverage', 'coverage-summary.json'), 'utf8'));
    writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), raw.replaceAll('E:\\\\proj', dir.replaceAll('\\', '\\\\')).replaceAll('e:/proj', lowerDriveDir));

    const files = new Set(['src/a.ts', 'src/b.ts']);
    const report = await readCoverage(dir, files, 0);

    expect(report).not.toBeNull();
    expect(report!.source).toBe('summary');
    expect(report!.lines).toBe(70);
    expect(report!.stale).toBe(false);
    expect(report!.files.map((f) => f.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(report!.files[0]).toEqual({ path: 'src/b.ts', lines: 50, uncovered: 5 });
  });

  it('marca stale quando o relatório é mais antigo que newestSourceMtimeMs', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    const summaryPath = join(dir, 'coverage', 'coverage-summary.json');
    copyFileSync(join(fixturesDir, 'coverage-summary.json'), summaryPath);
    const oldTime = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(summaryPath, oldTime, oldTime);

    const report = await readCoverage(dir, new Set(['src/a.ts']), oldTime.getTime() + 10_000);
    expect(report).not.toBeNull();
    expect(report!.stale).toBe(true);
  });

  it('lê lcov.info mínimo quando summary e final não existem', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    copyFileSync(join(fixturesDir, 'lcov.info'), join(dir, 'coverage', 'lcov.info'));

    const report = await readCoverage(dir, new Set(['src/a.ts']), 0);
    expect(report).not.toBeNull();
    expect(report!.source).toBe('lcov');
    expect(report!.lines).toBe(70);
    expect(report!.branches).toBe(50);
    expect(report!.functions).toBe(100);
  });

  it('retorna null sem lançar quando JSON de cobertura está corrompido', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), '{ inválido');

    await expect(readCoverage(dir, new Set(['src/a.ts']), 0)).resolves.toBeNull();
  });

  it('lê coverage-final.json do Istanbul quando coverage-summary não existe', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    writeFileSync(
      join(dir, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [join(dir, 'src', 'a.ts')]: {
          s: { '0': 1, '1': 1, '2': 0, '3': 0 },
          b: { '0': [1, 0] },
          f: { '0': 1, '1': 0 },
        },
      }),
    );

    const report = await readCoverage(dir, new Set(['src/a.ts']), 0);
    expect(report).not.toBeNull();
    expect(report!.source).toBe('final');
    expect(report!.lines).toBe(50);
    expect(report!.branches).toBe(50);
    expect(report!.functions).toBe(50);
    expect(report!.files).toEqual([{ path: 'src/a.ts', lines: 50, uncovered: 2 }]);
  });

  it('lê mutation.json com 3 mortos, 1 sobrevivente e 1 sem cobertura dando nota 60', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'reports', 'mutation'), { recursive: true });
    copyFileSync(join(fixturesDir, 'mutation.json'), join(dir, 'reports', 'mutation', 'mutation.json'));

    const report = await readMutation(dir, new Set(['src/a.ts']));
    expect(report).not.toBeNull();
    expect(report!.score).toBe(60);
    expect(report!.survivors).toEqual([
      { path: 'src/a.ts', line: 12, mutator: 'ConditionalExpression', replacement: 'true' },
    ]);
  });

  it('readMutation normaliza caminhos do Windows e retorna null quando JSON é inválido ou sem arquivos casando', async () => {
    const dir = tempProj();
    mkdirSync(join(dir, 'reports', 'mutation'), { recursive: true });
    const mutPath = join(dir, 'reports', 'mutation', 'mutation.json');

    const dirWin = dir.replaceAll('/', '\\');
    writeFileSync(
      mutPath,
      JSON.stringify({
        files: {
          [`${dirWin}\\src\\a.ts`]: {
            mutants: [
              { id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', location: { start: { line: 2 } }, status: 'Killed' },
            ],
          },
        },
      }),
    );
    const valid = await readMutation(dir, new Set(['src/a.ts']));
    expect(valid).not.toBeNull();
    expect(valid!.score).toBe(100);

    writeFileSync(mutPath, '{ quebrado');
    await expect(readMutation(dir, new Set(['src/a.ts']))).resolves.toBeNull();

    writeFileSync(mutPath, JSON.stringify({ files: { 'outro/fora.ts': { mutants: [] } } }));
    await expect(readMutation(dir, new Set(['src/a.ts']))).resolves.toBeNull();
  });

  it('retorna null quando coverage-final ou lcov não têm entradas válidas e aceita dir relativo', async () => {
    const emptyFinalDir = tempProj();
    mkdirSync(join(emptyFinalDir, 'coverage'), { recursive: true });
    writeFileSync(join(emptyFinalDir, 'coverage', 'coverage-final.json'), JSON.stringify({ foo: 'bar' }));
    await expect(readCoverage(emptyFinalDir, new Set(['src/a.ts']), 0)).resolves.toBeNull();

    const emptyLcovDir = tempProj();
    mkdirSync(join(emptyLcovDir, 'coverage'), { recursive: true });
    writeFileSync(join(emptyLcovDir, 'coverage', 'lcov.info'), 'texto sem registros válidos\n');
    await expect(readCoverage(emptyLcovDir, new Set(['src/a.ts']), 0)).resolves.toBeNull();

    const relProj = mkdtempSync(join(process.cwd(), '.tmp-rel-cov-'));
    temps.push(relProj);
    mkdirSync(join(relProj, 'coverage'), { recursive: true });
    writeFileSync(
      join(relProj, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: { lines: { pct: 80 } },
        [join(relProj, 'src', 'a.ts')]: { lines: { total: 10, covered: 8, pct: 80 } },
      }),
    );
    const relDir = relative(process.cwd(), relProj);
    const relReport = await readCoverage(relDir, new Set(['src/a.ts']), 0);
    expect(relReport).not.toBeNull();
    expect(relReport!.files).toEqual([{ path: 'src/a.ts', lines: 80, uncovered: 2 }]);
  });
});
