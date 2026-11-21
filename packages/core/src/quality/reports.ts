import { readFile, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { CoverageReport, MutationReport } from '@orquestra/shared';
import type { Logger } from '../log.js';

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeDrivePrefix(pathValue: string): string {
  return pathValue.replace(/^[a-zA-Z]:/, (drive) => drive.toUpperCase());
}

/** Converte caminho absoluto/relativo de relatório (inclusive Windows) para relativo ao projeto com `/`. */
function normalizeReportPath(rawPath: string, rootDir: string): string | null {
  const rootNorm = normalizeDrivePrefix(posix.normalize(resolve(rootDir).replaceAll('\\', '/'))).replace(/\/+$/, '');
  const rawNorm = normalizeDrivePrefix(posix.normalize(rawPath.replaceAll('\\', '/')));

  const isAbsolutePath = rawNorm.startsWith('/') || /^[A-Z]:\//.test(rawNorm);
  if (!isAbsolutePath) {
    const rel = rawNorm.replace(/^\.\//, '');
    return !rel || rel.startsWith('..') ? null : rel;
  }

  const prefix = `${rootNorm}/`;
  if (rawNorm.startsWith(prefix)) return rawNorm.slice(prefix.length);
  if (process.platform === 'win32' && rawNorm.toLowerCase().startsWith(prefix.toLowerCase())) {
    return rawNorm.slice(prefix.length);
  }
  return null;
}

async function readExisting(filePath: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [st, text] = await Promise.all([stat(filePath), readFile(filePath, 'utf8')]);
    return { text, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

type CoverageMetricBucket = { total?: unknown; covered?: unknown; pct?: unknown };

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCoverageSummary(
  data: unknown,
  rootDir: string,
  files: ReadonlySet<string>,
  mtimeMs: number,
  newestSourceMtimeMs: number,
): CoverageReport | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, { lines?: CoverageMetricBucket; branches?: CoverageMetricBucket; functions?: CoverageMetricBucket }>;
  const total = record.total;
  const linesPct = finiteNumber(total?.lines?.pct);
  if (linesPct === null) return null;

  const branchesPct = finiteNumber(total?.branches?.pct);
  const functionsPct = finiteNumber(total?.functions?.pct);

  const fileEntries: CoverageReport['files'] = [];
  for (const [rawPath, entry] of Object.entries(record)) {
    if (rawPath === 'total' || !entry?.lines) continue;
    const rel = normalizeReportPath(rawPath, rootDir);
    if (!rel || !files.has(rel)) continue;
    const lineTotal = finiteNumber(entry.lines.total) ?? 0;
    const lineCovered = finiteNumber(entry.lines.covered) ?? 0;
    const uncovered = Math.max(0, lineTotal - lineCovered);
    const pct = finiteNumber(entry.lines.pct) ?? (lineTotal > 0 ? (lineCovered / lineTotal) * 100 : 100);
    fileEntries.push({ path: rel, lines: round1(pct), uncovered });
  }

  fileEntries.sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path));
  return {
    source: 'summary',
    generatedAt: new Date(mtimeMs).toISOString(),
    stale: mtimeMs < newestSourceMtimeMs,
    lines: round1(linesPct),
    branches: branchesPct === null ? null : round1(branchesPct),
    functions: functionsPct === null ? null : round1(functionsPct),
    files: fileEntries.slice(0, 10),
  };
}

function parseCoverageFinal(
  data: unknown,
  rootDir: string,
  files: ReadonlySet<string>,
  mtimeMs: number,
  newestSourceMtimeMs: number,
): CoverageReport | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  let totalStatements = 0;
  let coveredStatements = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  let totalFunctions = 0;
  let coveredFunctions = 0;

  const fileEntries: CoverageReport['files'] = [];
  for (const [rawPath, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const rel = normalizeReportPath(rawPath, rootDir);
    if (!rel || !files.has(rel)) continue;
    const istanbul = entry as {
      s?: Record<string, unknown>;
      b?: Record<string, unknown>;
      f?: Record<string, unknown>;
    };

    let sTotal = 0;
    let sCovered = 0;
    if (istanbul.s && typeof istanbul.s === 'object') {
      for (const hits of Object.values(istanbul.s)) {
        if (typeof hits !== 'number') continue;
        sTotal++;
        if (hits > 0) sCovered++;
      }
    }
    totalStatements += sTotal;
    coveredStatements += sCovered;

    if (istanbul.b && typeof istanbul.b === 'object') {
      for (const arms of Object.values(istanbul.b)) {
        if (!Array.isArray(arms)) continue;
        for (const hits of arms) {
          if (typeof hits !== 'number') continue;
          totalBranches++;
          if (hits > 0) coveredBranches++;
        }
      }
    }

    if (istanbul.f && typeof istanbul.f === 'object') {
      for (const hits of Object.values(istanbul.f)) {
        if (typeof hits !== 'number') continue;
        totalFunctions++;
        if (hits > 0) coveredFunctions++;
      }
    }

    const uncovered = Math.max(0, sTotal - sCovered);
    const pct = sTotal > 0 ? round1((sCovered / sTotal) * 100) : 100;
    fileEntries.push({ path: rel, lines: pct, uncovered });
  }

  if (fileEntries.length === 0) return null;

  fileEntries.sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path));
  return {
    source: 'final',
    generatedAt: new Date(mtimeMs).toISOString(),
    stale: mtimeMs < newestSourceMtimeMs,
    lines: totalStatements > 0 ? round1((coveredStatements / totalStatements) * 100) : 0,
    branches: totalBranches > 0 ? round1((coveredBranches / totalBranches) * 100) : null,
    functions: totalFunctions > 0 ? round1((coveredFunctions / totalFunctions) * 100) : null,
    files: fileEntries.slice(0, 10),
  };
}

function parseLcov(
  text: string,
  rootDir: string,
  files: ReadonlySet<string>,
  mtimeMs: number,
  newestSourceMtimeMs: number,
): CoverageReport | null {
  let lfTotal = 0;
  let lhTotal = 0;
  let brfTotal = 0;
  let brhTotal = 0;
  let fnfTotal = 0;
  let fnhTotal = 0;
  const fileEntries: CoverageReport['files'] = [];

  let currentPath: string | null = null;
  let lf = 0;
  let lh = 0;
  let brf = 0;
  let brh = 0;
  let fnf = 0;
  let fnh = 0;

  const flush = () => {
    if (!currentPath) return;
    const rel = normalizeReportPath(currentPath, rootDir);
    if (rel && files.has(rel)) {
      lfTotal += lf;
      lhTotal += lh;
      brfTotal += brf;
      brhTotal += brh;
      fnfTotal += fnf;
      fnhTotal += fnh;
      const uncovered = Math.max(0, lf - lh);
      const pct = lf > 0 ? round1((lh / lf) * 100) : 100;
      fileEntries.push({ path: rel, lines: pct, uncovered });
    }
    currentPath = null;
    lf = 0;
    lh = 0;
    brf = 0;
    brh = 0;
    fnf = 0;
    fnh = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'end_of_record') {
      flush();
    } else if (line.startsWith('SF:')) {
      currentPath = line.slice(3);
    } else if (line.startsWith('LF:')) {
      lf = Number(line.slice(3)) || 0;
    } else if (line.startsWith('LH:')) {
      lh = Number(line.slice(3)) || 0;
    } else if (line.startsWith('BRF:')) {
      brf = Number(line.slice(4)) || 0;
    } else if (line.startsWith('BRH:')) {
      brh = Number(line.slice(4)) || 0;
    } else if (line.startsWith('FNF:')) {
      fnf = Number(line.slice(4)) || 0;
    } else if (line.startsWith('FNH:')) {
      fnh = Number(line.slice(4)) || 0;
    }
  }
  flush();
  if (fileEntries.length === 0) return null;

  fileEntries.sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path));
  return {
    source: 'lcov',
    generatedAt: new Date(mtimeMs).toISOString(),
    stale: mtimeMs < newestSourceMtimeMs,
    lines: lfTotal > 0 ? round1((lhTotal / lfTotal) * 100) : 0,
    branches: brfTotal > 0 ? round1((brhTotal / brfTotal) * 100) : null,
    functions: fnfTotal > 0 ? round1((fnhTotal / fnfTotal) * 100) : null,
    files: fileEntries.slice(0, 10),
  };
}

/** Lê relatório de cobertura existente em `coverage/` (`coverage-summary.json`, `coverage-final.json` ou `lcov.info`). */
export async function readCoverage(
  dir: string,
  files: ReadonlySet<string>,
  newestSourceMtimeMs: number,
  log?: Pick<Logger, 'warn'>,
): Promise<CoverageReport | null> {
  const summaryPath = join(dir, 'coverage', 'coverage-summary.json');
  const summary = await readExisting(summaryPath);
  if (summary) {
    try {
      return parseCoverageSummary(JSON.parse(summary.text), dir, files, summary.mtimeMs, newestSourceMtimeMs);
    } catch (err) {
      log?.warn({ err, path: summaryPath }, 'falha ao ler coverage-summary.json');
      return null;
    }
  }

  const finalPath = join(dir, 'coverage', 'coverage-final.json');
  const final = await readExisting(finalPath);
  if (final) {
    try {
      return parseCoverageFinal(JSON.parse(final.text), dir, files, final.mtimeMs, newestSourceMtimeMs);
    } catch (err) {
      log?.warn({ err, path: finalPath }, 'falha ao ler coverage-final.json');
      return null;
    }
  }

  const lcovPath = join(dir, 'coverage', 'lcov.info');
  const lcov = await readExisting(lcovPath);
  if (lcov) {
    return parseLcov(lcov.text, dir, files, lcov.mtimeMs, newestSourceMtimeMs);
  }

  return null;
}

/** Lê relatório de mutação do Stryker em `reports/mutation/mutation.json`. */
export async function readMutation(
  dir: string,
  files: ReadonlySet<string>,
  log?: Pick<Logger, 'warn'>,
): Promise<MutationReport | null> {
  const mutationPath = join(dir, 'reports', 'mutation', 'mutation.json');
  const existing = await readExisting(mutationPath);
  if (!existing) return null;

  let data: unknown;
  try {
    data = JSON.parse(existing.text);
  } catch (err) {
    log?.warn({ err, path: mutationPath }, 'falha ao ler mutation.json');
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  const rawFiles = (data as { files?: unknown }).files;
  if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return null;

  let totalKilled = 0;
  let totalSurvived = 0;
  let totalNoCoverage = 0;
  const fileEntries: MutationReport['files'] = [];
  const survivors: MutationReport['survivors'] = [];

  for (const [rawPath, entry] of Object.entries(rawFiles as Record<string, unknown>)) {
    const rel = normalizeReportPath(rawPath, dir);
    if (!rel || !files.has(rel) || !entry || typeof entry !== 'object') continue;
    const mutants = (entry as { mutants?: unknown }).mutants;
    if (!Array.isArray(mutants)) continue;

    let killed = 0;
    let survived = 0;
    let noCoverage = 0;

    for (const mutant of mutants) {
      if (!mutant || typeof mutant !== 'object') continue;
      const m = mutant as {
        status?: unknown;
        mutatorName?: unknown;
        replacement?: unknown;
        location?: { start?: { line?: unknown } };
      };
      if (m.status === 'Killed' || m.status === 'Timeout') {
        killed++;
      } else if (m.status === 'Survived') {
        survived++;
        if (survivors.length < 50) {
          survivors.push({
            path: rel,
            line: typeof m.location?.start?.line === 'number' ? m.location.start.line : 1,
            mutator: typeof m.mutatorName === 'string' ? m.mutatorName : '',
            replacement: typeof m.replacement === 'string' ? m.replacement : '',
          });
        }
      } else if (m.status === 'NoCoverage') {
        noCoverage++;
      }
    }

    totalKilled += killed;
    totalSurvived += survived;
    totalNoCoverage += noCoverage;
    const denom = killed + survived + noCoverage;
    fileEntries.push({
      path: rel,
      score: denom > 0 ? round1((killed / denom) * 100) : 0,
      killed,
      survived,
      noCoverage,
    });
  }

  if (fileEntries.length === 0) return null;

  fileEntries.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  const totalDenom = totalKilled + totalSurvived + totalNoCoverage;
  return {
    generatedAt: new Date(existing.mtimeMs).toISOString(),
    score: totalDenom > 0 ? round1((totalKilled / totalDenom) * 100) : 0,
    files: fileEntries,
    survivors,
  };
}
