import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareReports,
  gitChanged,
  gitChurn,
  listProjectFiles,
  measureProject,
  readLastReport,
  saveReport,
} from '../src/quality/measure.js';

const execFileAsync = promisify(execFile);
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('measureProject, hotspots, compareReports e snapshot', () => {
  it('mede tamanho, ciclos, ignora node_modules e exclui testes dos hotspots', async () => {
    const dir = tempDir('orq-measure-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });

    const bigLines = Array.from({ length: 700 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    writeFileSync(join(dir, 'src', 'big.ts'), bigLines);
    writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
    writeFileSync(join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport const b = () => a;\n");
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'export function hugeTest() {\n  if (true) {}\n}\n');
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');

    const report = await measureProject(dir);
    expect(report.language).toBe('js-ts');
    expect(report.metrics.find((m) => m.id === 'size')).toMatchObject({ signal: 'bad', value: 700 });
    expect(report.metrics.find((m) => m.id === 'dependencies')).toMatchObject({ signal: 'bad', value: 1 });
    expect(report.files.some((f) => f.path.includes('node_modules'))).toBe(false);

    const testFile = report.files.find((f) => f.path === 'src/a.test.ts');
    expect(testFile?.test).toBe(true);
    expect(report.hotspots.some((h) => h.path === 'src/a.test.ts')).toBe(false);
    // Sem git: commits90d é null e changed vem vazio
    expect(testFile?.commits90d).toBeNull();
    expect(report.changed).toEqual([]);
  });

  it('retorna language unsupported e métricas missing para projeto sem JS/TS', async () => {
    const dir = tempDir('orq-py-');
    writeFileSync(join(dir, 'main.py'), 'print("oi")\n');

    const report = await measureProject(dir);
    expect(report.language).toBe('unsupported');
    expect(report.metrics).toHaveLength(5);
    expect(report.metrics.every((m) => m.signal === 'missing' && m.value === null)).toBe(true);
    expect(report.files).toEqual([]);
  });

  it('compareReports detecta file-over-limit e calcula delta +100 quando big.ts passa de 350 linhas', async () => {
    const dir = tempDir('orq-cmp-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'big.ts'),
      Array.from({ length: 300 }, (_, i) => `export const a${i} = ${i};`).join('\n'),
    );
    const previous = await measureProject(dir);

    writeFileSync(
      join(dir, 'src', 'big.ts'),
      Array.from({ length: 400 }, (_, i) => `export const a${i} = ${i};`).join('\n'),
    );
    const current = await measureProject(dir);

    const compared = compareReports(previous, current, new Set(['src/big.ts']));
    expect(compared.metrics.find((m) => m.id === 'size')?.delta).toBe(100);
    expect(compared.changed).toEqual([
      expect.objectContaining({ path: 'src/big.ts', kind: 'file-over-limit' }),
    ]);
  });

  it('saveReport preserva medição anterior em previous.json e readLastReport rejeita JSON inválido', async () => {
    const dir = tempDir('orq-snap-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'one.ts'), 'export const x = 1;\n');
    const first = await measureProject(dir);

    writeFileSync(join(dir, 'src', 'one.ts'), 'export const x = 1;\nexport const y = 2;\n');
    const second = await measureProject(dir);

    await saveReport(dir, first);
    await saveReport(dir, second);

    const last = await readLastReport(dir);
    expect(last?.metrics.find((m) => m.id === 'size')?.value).toBe(2);

    const { readFile } = await import('node:fs/promises');
    const prevRaw = JSON.parse(await readFile(join(dir, '.orquestra', 'quality', 'previous.json'), 'utf8'));
    expect(prevRaw.metrics.find((m: { id: string }) => m.id === 'size').value).toBe(1);

    writeFileSync(join(dir, '.orquestra', 'quality', 'last.json'), '{ quebrado');
    await expect(readLastReport(dir)).resolves.toBeNull();
  });

  it('num repositório git lê commits90d e arquivos alterados com gitChanged/gitChurn (com espaço, acento e caminho relativo)', async () => {
    const dir = tempDir('orq-git-');
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export function ok() { return 1; }\n');
    writeFileSync(join(dir, 'src', 'relatório com espaço.ts'), 'export const r = 1;\n');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });

    // Modifica o arquivo com acento e espaço e cria outro não rastreado com acento
    writeFileSync(join(dir, 'src', 'app.ts'), 'export function ok() { return 2; }\n');
    writeFileSync(join(dir, 'src', 'relatório com espaço.ts'), 'export const r = 2;\n');
    writeFileSync(join(dir, 'src', 'novo módulo.ts'), 'export const n = 1;\n');

    const report = await measureProject(dir);
    expect(report.files.find((f) => f.path === 'src/app.ts')?.commits90d).toBe(1);
    expect(report.files.find((f) => f.path === 'src/relatório com espaço.ts')?.commits90d).toBe(1);

    const churn = await gitChurn(dir);
    expect(churn?.get('src/relatório com espaço.ts')).toBe(1);

    const changed = await gitChanged(dir);
    expect(changed?.has('src/app.ts')).toBe(true);
    expect(changed?.has('src/relatório com espaço.ts')).toBe(true);
    expect(changed?.has('src/novo módulo.ts')).toBe(true);

    // Testa gitChanged com caminho relativo ao cwd atual
    const relRepo = mkdtempSync(join(process.cwd(), '.tmp-rel-git-'));
    temps.push(relRepo);
    await execFileAsync('git', ['init'], { cwd: relRepo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: relRepo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: relRepo });
    mkdirSync(join(relRepo, 'src'), { recursive: true });
    writeFileSync(join(relRepo, 'src', 'rel.ts'), 'export const x = 1;\n');
    const changedRel = await gitChanged(relative(process.cwd(), relRepo));
    expect(changedRel?.has('src/rel.ts')).toBe(true);
  });

  it('exclui funções de arquivos de teste de report.functions e mantém hotspots em git recém-iniciado sem commits', async () => {
    const dir = tempDir('orq-empty-git-');
    await execFileAsync('git', ['init'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'worker.ts'),
      'export function complexa(a: boolean, b: boolean) { if (a && b) return 1; return 0; }\n',
    );
    writeFileSync(
      join(dir, 'src', 'worker.test.ts'),
      'export function testeGigante(a: boolean) { if (a) { if (a) { if (a) return 1; } } return 0; }\n',
    );

    const report = await measureProject(dir);
    expect(report.functions.some((fn) => fn.path === 'src/worker.test.ts')).toBe(false);
    expect(report.functions.some((fn) => fn.name === 'complexa')).toBe(true);
    expect(report.files.find((f) => f.path === 'src/worker.ts')?.commits90d).toBeNull();
    expect(report.hotspots.some((h) => h.path === 'src/worker.ts')).toBe(true);
  });

  it('pula arquivos acima de 1 MB (skippedLarge) e mantém language js-ts mesmo se todos forem pulados', async () => {
    const dir = tempDir('orq-large-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'huge.ts'), 'export const x = "' + 'a'.repeat(1_050_000) + '";\n');

    const listed = await listProjectFiles(dir);
    expect(listed.skippedLarge).toBe(1);
    expect(listed.files).toEqual([]);

    const report = await measureProject(dir);
    expect(report.language).toBe('js-ts');
    expect(report.limits.skippedLarge).toBe(1);
  });

  it('compareReports detecta function-over-limit, new-cycle e todas violações quando previous é null', async () => {
    const dir = tempDir('orq-cmp-all-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function ok() { return 1; }\n');
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    const previous = await measureProject(dir);

    writeFileSync(
      join(dir, 'src', 'a.ts'),
      [
        "import { b } from './b';",
        'export function complexFn(n: number) {',
        '  if (n===1 || n===2 || n===3 || n===4 || n===5 || n===6 || n===7 || n===8 || n===9 || n===10 || n===11) return b;',
        '  return 0;',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'src', 'b.ts'), "import { complexFn } from './a';\nexport const b = complexFn;\n");
    const current = await measureProject(dir);

    const compared = compareReports(previous, current, new Set(['src/a.ts']));
    expect(compared.changed.some((c) => c.kind === 'function-over-limit' && c.path === 'src/a.ts')).toBe(true);
    expect(compared.changed.some((c) => c.kind === 'new-cycle' && c.path === 'src/a.ts')).toBe(true);

    const initialCompared = compareReports(null, current, new Set(['src/a.ts']));
    expect(initialCompared.changed.some((c) => c.kind === 'function-over-limit')).toBe(true);
    expect(initialCompared.changed.some((c) => c.kind === 'new-cycle')).toBe(true);
  });
});
