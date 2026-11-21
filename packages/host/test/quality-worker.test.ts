import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QualityReport } from '@orquestra/shared';
import { measureQualityIsolated } from '../src/quality-worker.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function sampleReport(dir: string): QualityReport {
  return {
    version: 1,
    dir,
    measuredAt: '2026-11-20T12:00:00.000Z',
    durationMs: 10,
    language: 'js-ts',
    limits: { files: 1, skippedLarge: 0, truncated: false },
    metrics: [
      { id: 'size', signal: 'ok', value: 10, delta: null },
      { id: 'complexity', signal: 'ok', value: 1, delta: null },
      { id: 'dependencies', signal: 'ok', value: 0, delta: null },
      { id: 'coverage', signal: 'missing', value: null, delta: null },
      { id: 'mutation', signal: 'missing', value: null, delta: null },
    ],
    files: [],
    functions: [],
    cycles: [],
    hotspots: [],
    changed: [],
    coverage: null,
    mutation: null,
  };
}

describe('measureQualityIsolated', () => {
  it('resolve com relatório válido emitido pelo script filho', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-qworker-ok-'));
    temps.push(dir);
    const script = join(dir, 'fake-worker.mjs');
    const report = sampleReport(dir);
    writeFileSync(
      script,
      `process.stdout.write(JSON.stringify({ ok: true, report: ${JSON.stringify(report)} }));`,
    );

    const started: number[] = [];
    const exited: number[] = [];
    const result = await measureQualityIsolated({
      script,
      dir,
      signal: new AbortController().signal,
      onStart: (pid) => started.push(pid),
      onExit: (pid) => exited.push(pid),
    });

    expect(result).toEqual(report);
    expect(started).toHaveLength(1);
    expect(exited).toEqual(started);
  });

  it('rejeita com mensagem em pt-BR quando o script devolve JSON inválido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-qworker-bad-'));
    temps.push(dir);
    const script = join(dir, 'bad-worker.mjs');
    writeFileSync(script, `process.stdout.write('{ json inválido');`);

    await expect(
      measureQualityIsolated({
        script,
        dir,
        signal: new AbortController().signal,
        onStart: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow(/não reconhecida|inválid/i);
  });

  it('encerra o processo filho pelo PID ao abortar o signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-qworker-abort-'));
    temps.push(dir);
    const script = join(dir, 'hang-worker.mjs');
    writeFileSync(script, `setTimeout(() => {}, 30000);`);

    const ac = new AbortController();
    let childPid: number | undefined;
    const promise = measureQualityIsolated({
      script,
      dir,
      signal: ac.signal,
      onStart: (pid) => {
        childPid = pid;
        setTimeout(() => ac.abort(), 50);
      },
      onExit: () => {},
    });

    await expect(promise).rejects.toThrow(/cancelada/i);
    expect(childPid).toBeTypeOf('number');
    await expect.poll(() => {
      try {
        process.kill(childPid!, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5000 }).toBe(false);
  });

  it('rejeita com a mensagem de erro quando o script devolve { ok: false, error } ou relatório fora do schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-qworker-err-'));
    temps.push(dir);
    const errScript = join(dir, 'err-worker.mjs');
    writeFileSync(errScript, `process.stdout.write(JSON.stringify({ ok: false, error: 'Erro customizado do worker' }));`);

    await expect(
      measureQualityIsolated({
        script: errScript,
        dir,
        signal: new AbortController().signal,
        onStart: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow('Erro customizado do worker');

    const schemaScript = join(dir, 'schema-worker.mjs');
    writeFileSync(schemaScript, `process.stdout.write(JSON.stringify({ ok: true, report: { version: 2 } }));`);

    await expect(
      measureQualityIsolated({
        script: schemaScript,
        dir,
        signal: new AbortController().signal,
        onStart: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow(/não reconhecida/i);
  });

  it('limita a saída pelos bytes UTF-8 (32 MB), não pelo tamanho em caracteres UTF-16', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-qworker-utf8-'));
    temps.push(dir);
    const script = join(dir, 'utf8-worker.mjs');
    // 'é' tem 1 caractere UTF-16 e 2 bytes UTF-8: 17 milhões de 'é' < 32M chars, > 34 MB UTF-8.
    writeFileSync(script, `process.stdout.write('é'.repeat(17_000_000));`);

    await expect(
      measureQualityIsolated({
        script,
        dir,
        signal: new AbortController().signal,
        onStart: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow(/limite de 32 MB/i);
  });
});
