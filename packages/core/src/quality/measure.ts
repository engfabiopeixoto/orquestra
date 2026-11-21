import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import {
  QUALITY_LIMITS,
  QUALITY_METRICS,
  qualityReportSchema,
  signalFor,
  type QualityChange,
  type QualityCycle,
  type QualityFile,
  type QualityFunction,
  type QualityHotspot,
  type QualityMetric,
  type QualityReport,
} from '@orquestra/shared';
import {
  ANALYZED_EXTENSIONS,
  buildImportGraph,
  findCycles,
  readPathAliases,
} from './import-graph.js';
import { readCoverage, readMutation } from './reports.js';
import { analyzeSource, type ImportRef } from './source-metrics.js';

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const ANALYZED_EXT_SET = new Set<string>(ANALYZED_EXTENSIONS);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.orquestra',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'reports',
]);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e']);

const slash = (value: string) => value.replaceAll('\\', '/');
const round1 = (value: number) => Math.round(value * 10) / 10;

function git(dir: string, args: string[]): Promise<string> {
  const standard = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe');
  const command = existsSync(standard) ? standard : 'git';
  return new Promise((resolveResult, reject) =>
    execFile(
      command,
      ['--literal-pathspecs', '-C', dir, ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => (error ? reject(error) : resolveResult(stdout)),
    ),
  );
}

function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIRS.has(parts[i]!)) return true;
  }
  return false;
}

function isAnalyzedFilename(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts') || lower.endsWith('.min.js')) {
    return false;
  }
  return ANALYZED_EXT_SET.has(extname(lower));
}

function isTestFile(relPath: string): boolean {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (TEST_DIRS.has(parts[i]!)) return true;
  }
  const fileName = parts[parts.length - 1] ?? '';
  return /\.(test|spec)\.[^.]+$/i.test(fileName);
}

async function walkDirectory(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        const rel = slash(relative(root, full));
        if (isAnalyzedFilename(rel)) results.push(rel);
      }
    }
  }
  return results;
}

/** Lista arquivos JS/TS analisáveis respeitando `.gitignore` (quando há git), pastas ignoradas e limites de segurança. */
export async function listProjectFiles(
  dir: string,
): Promise<{ files: string[]; skippedLarge: number; truncated: boolean }> {
  let candidates: string[] | null = null;
  try {
    const raw = await git(dir, ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    candidates = raw
      .split('\0')
      .map(slash)
      .filter((rel) => rel.length > 0 && !isIgnoredPath(rel) && isAnalyzedFilename(rel));
  } catch {
    candidates = null;
  }

  if (!candidates) {
    candidates = await walkDirectory(dir);
  }

  candidates = [...new Set(candidates)].sort();

  const files: string[] = [];
  let skippedLarge = 0;
  let truncated = false;

  for (const rel of candidates) {
    let st;
    try {
      st = await stat(join(dir, rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      skippedLarge++;
      continue;
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.push(rel);
  }

  return { files, skippedLarge, truncated };
}

/** Conta quantas vezes cada arquivo foi alterado nos últimos 90 dias via git; retorna `null` fora de git ou sem commits. */
export async function gitChurn(dir: string): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  try {
    const raw = await git(dir, [
      '-c',
      'core.quotePath=false',
      'log',
      '--relative',
      '--since=90.days',
      '--name-only',
      '--pretty=format:',
      '-z',
      '--',
      '.',
    ]);
    for (const entry of raw.split('\0')) {
      const rel = slash(entry);
      if (!rel) continue;
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
}

/** Lista arquivos modificados ou não rastreados no `git status`; retorna `null` fora de repositório git. */
export async function gitChanged(dir: string): Promise<Set<string> | null> {
  let prefix: string;
  let status: string;
  try {
    prefix = (await git(dir, ['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
    status = await git(dir, [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ]);
  } catch {
    return null;
  }

  const toLocal = (path: string) =>
    prefix ? (path.startsWith(prefix) ? path.slice(prefix.length) : null) : path;

  const changed = new Set<string>();
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const flag = record.slice(0, 2);
    const localPath = toLocal(slash(record.slice(3)));
    if (/[RC]/.test(flag)) i++;
    if (localPath) changed.add(localPath);
  }
  return changed;
}

/** Calcula os 10 principais pontos críticos entre arquivos que não são de teste. */
export function hotspots(files: QualityFile[], functions: QualityFunction[] = []): QualityHotspot[] {
  const topFnByFile = new Map<string, QualityFunction>();
  for (const fn of functions) {
    const current = topFnByFile.get(fn.path);
    if (!current || fn.complexity > current.complexity || (fn.complexity === current.complexity && fn.loc > current.loc)) {
      topFnByFile.set(fn.path, fn);
    }
  }

  const scored: QualityHotspot[] = [];
  for (const file of files) {
    if (file.test) continue;
    const commitsFactor = file.commits90d ?? 1;
    const rawScore = (commitsFactor * file.sumComplexity * file.loc) / 100;
    if (rawScore <= 0) continue;
    const score = Math.round(rawScore * 100) / 100;

    const topFn = topFnByFile.get(file.path);
    const parts = [`${file.loc} ${file.loc === 1 ? 'linha' : 'linhas'}`];
    if (topFn) {
      parts.push(`função ${topFn.name} com complexidade ${topFn.complexity}`);
    } else if (file.maxComplexity > 0) {
      parts.push(`complexidade máxima ${file.maxComplexity}`);
    }
    if (file.commits90d !== null) {
      parts.push(`alterado ${file.commits90d} ${file.commits90d === 1 ? 'vez' : 'vezes'} em 90 dias`);
    }

    scored.push({ path: file.path, score, reason: parts.join(', ') });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, 10);
}

function cycleKey(cycle: QualityCycle): string {
  return `${cycle.typeOnly ? 'T' : 'R'}:${cycle.files.join('\0')}`;
}

/** Compara o relatório atual com o anterior e aponta o que piorou nos arquivos alterados. */
export function compareReports(
  previous: QualityReport | null,
  current: Omit<QualityReport, 'changed'>,
  changedFiles: Set<string> | null,
): { metrics: QualityMetric[]; changed: QualityChange[] } {
  const prevMetrics = new Map(previous?.metrics.map((m) => [m.id, m]));
  const metrics: QualityMetric[] = QUALITY_METRICS.map((id) => {
    const curr = current.metrics.find((m) => m.id === id) ?? { id, signal: 'missing' as const, value: null, delta: null };
    const prev = prevMetrics.get(id);
    const delta =
      prev && prev.value !== null && curr.value !== null ? round1(curr.value - prev.value) : null;
    return { ...curr, delta };
  });

  const changed: QualityChange[] = [];
  if (!changedFiles || changedFiles.size === 0) {
    return { metrics, changed };
  }

  const prevFiles = new Map(previous?.files.map((f) => [f.path, f]));
  const prevCycles = new Set((previous?.cycles ?? []).map(cycleKey));
  const currFilesMap = new Map(current.files.map((f) => [f.path, f]));

  for (const filePath of [...changedFiles].sort()) {
    const currFile = currFilesMap.get(filePath);
    if (!currFile) continue;
    const prevFile = prevFiles.get(filePath);

    if (!currFile.test && currFile.loc > QUALITY_LIMITS.fileLoc.warn && (!prevFile || prevFile.loc <= QUALITY_LIMITS.fileLoc.warn)) {
      changed.push({
        path: filePath,
        kind: 'file-over-limit',
        detail: `Passou de ${QUALITY_LIMITS.fileLoc.warn} linhas (${currFile.loc} linhas).`,
      });
    }

    if (!currFile.test) {
      const prevOverNames = new Set(
        (previous?.functions ?? [])
          .filter((fn) => fn.path === filePath && fn.complexity > QUALITY_LIMITS.complexity.warn)
          .map((fn) => fn.name),
      );
      for (const fn of current.functions) {
        if (fn.path === filePath && fn.complexity > QUALITY_LIMITS.complexity.warn && !prevOverNames.has(fn.name)) {
          changed.push({
            path: filePath,
            kind: 'function-over-limit',
            detail: `Função ${fn.name} (linha ${fn.line}) tem complexidade ${fn.complexity} (limite ${QUALITY_LIMITS.complexity.warn}).`,
          });
        }
      }
    }

    for (const cycle of current.cycles) {
      if (cycle.files.includes(filePath) && !prevCycles.has(cycleKey(cycle))) {
        changed.push({
          path: filePath,
          kind: 'new-cycle',
          detail: `Novo ciclo ${cycle.typeOnly ? 'apenas de tipos ' : ''}envolvendo: ${cycle.files.join(' ↔ ')}.`,
        });
      }
    }
  }

  return { metrics, changed };
}

function unsupportedReport(
  dir: string,
  startedAt: number,
  limits: { files: number; skippedLarge: number; truncated: boolean },
): QualityReport {
  return {
    version: 1,
    dir,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    language: 'unsupported',
    limits,
    metrics: QUALITY_METRICS.map((id) => ({ id, signal: 'missing', value: null, delta: null })),
    files: [],
    functions: [],
    cycles: [],
    hotspots: [],
    changed: [],
    coverage: null,
    mutation: null,
  };
}

/** Mede estaticamente o projeto JS/TS em `dir` e lê relatórios existentes sem gravar em disco. */
export async function measureProject(dir: string): Promise<QualityReport> {
  const startedAt = Date.now();
  const listed = await listProjectFiles(dir);
  if (listed.files.length === 0 && listed.skippedLarge === 0) {
    return unsupportedReport(dir, startedAt, {
      files: 0,
      skippedLarge: listed.skippedLarge,
      truncated: listed.truncated,
    });
  }

  const [aliases, churn] = await Promise.all([readPathAliases(dir), gitChurn(dir)]);

  const fileSet = new Set(listed.files);
  const importsMap = new Map<string, ImportRef[]>();
  const allFunctions: QualityFunction[] = [];
  const analyzedPerFile = new Map<
    string,
    { loc: number; test: boolean; fnCount: number; maxComplexity: number; sumComplexity: number; maxDepth: number }
  >();
  let newestSourceMtimeMs = 0;

  for (let i = 0; i < listed.files.length; i += 20) {
    const batch = listed.files.slice(i, i + 20);
    await Promise.all(
      batch.map(async (relPath) => {
        const fullPath = join(dir, relPath);
        let text: string;
        try {
          const [st, content] = await Promise.all([stat(fullPath), readFile(fullPath, 'utf8')]);
          if (st.mtimeMs > newestSourceMtimeMs) newestSourceMtimeMs = st.mtimeMs;
          text = content;
        } catch {
          return;
        }

        const metrics = analyzeSource(relPath, text);
        importsMap.set(relPath, metrics.imports);

        const test = isTestFile(relPath);
        let maxComplexity = 0;
        let sumComplexity = 0;
        let maxDepth = 0;
        for (const fn of metrics.functions) {
          if (fn.complexity > maxComplexity) maxComplexity = fn.complexity;
          sumComplexity += fn.complexity;
          if (fn.depth > maxDepth) maxDepth = fn.depth;
          if (!test) allFunctions.push({ path: relPath, ...fn });
        }

        analyzedPerFile.set(relPath, {
          loc: metrics.loc,
          test,
          fnCount: metrics.functions.length,
          maxComplexity,
          sumComplexity,
          maxDepth,
        });
      }),
    );
  }

  const graph = buildImportGraph(importsMap, fileSet, aliases);
  const cycles = findCycles(graph);

  const files: QualityFile[] = [];
  let maxFileLoc = 0;
  let maxNonTestComplexity = 0;
  let maxNonTestDepth = 0;

  for (const relPath of listed.files) {
    const info = analyzedPerFile.get(relPath);
    if (!info) continue;
    if (!info.test) {
      if (info.loc > maxFileLoc) maxFileLoc = info.loc;
      if (info.maxComplexity > maxNonTestComplexity) maxNonTestComplexity = info.maxComplexity;
      if (info.maxDepth > maxNonTestDepth) maxNonTestDepth = info.maxDepth;
    }

    files.push({
      path: relPath,
      loc: info.loc,
      test: info.test,
      functions: info.fnCount,
      maxComplexity: info.maxComplexity,
      sumComplexity: info.sumComplexity,
      maxDepth: info.maxDepth,
      fanIn: graph.fanIn.get(relPath) ?? 0,
      fanOut: graph.fanOut.get(relPath) ?? 0,
      commits90d: churn ? (churn.get(relPath) ?? 0) : null,
    });
  }

  const sortedFunctions = [...allFunctions].sort(
    (a, b) => b.complexity - a.complexity || b.depth - a.depth || b.loc - a.loc || a.path.localeCompare(b.path) || a.line - b.line,
  );
  const top20 = new Set(sortedFunctions.slice(0, 20));
  const reportedFunctions = sortedFunctions.filter(
    (fn) => fn.complexity > QUALITY_LIMITS.complexity.warn || top20.has(fn),
  );

  const [coverage, mutation] = await Promise.all([
    readCoverage(dir, fileSet, newestSourceMtimeMs),
    readMutation(dir, fileSet),
  ]);

  const runtimeCycles = cycles.filter((c) => !c.typeOnly).length;
  const typeOnlyCycles = cycles.filter((c) => c.typeOnly).length;
  const coverageValue = coverage ? coverage.lines : null;
  const mutationValue = mutation ? mutation.score : null;

  const metrics: QualityMetric[] = [
    { id: 'size', signal: signalFor('size', maxFileLoc), value: maxFileLoc, delta: null },
    {
      id: 'complexity',
      signal: signalFor('complexity', maxNonTestComplexity, { maxDepth: maxNonTestDepth }),
      value: maxNonTestComplexity,
      delta: null,
    },
    {
      id: 'dependencies',
      signal: signalFor('dependencies', runtimeCycles, { typeOnlyCycles }),
      value: runtimeCycles,
      delta: null,
    },
    { id: 'coverage', signal: signalFor('coverage', coverageValue), value: coverageValue, delta: null },
    { id: 'mutation', signal: signalFor('mutation', mutationValue), value: mutationValue, delta: null },
  ];

  return {
    version: 1,
    dir,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    language: 'js-ts',
    limits: {
      files: files.length,
      skippedLarge: listed.skippedLarge,
      truncated: listed.truncated,
    },
    metrics,
    files,
    functions: reportedFunctions,
    cycles,
    hotspots: hotspots(files, allFunctions),
    changed: [],
    coverage,
    mutation,
  };
}

/** Lê `.orquestra/quality/last.json` validando pelo schema; retorna `null` se ausente ou inválido. */
export async function readLastReport(dir: string): Promise<QualityReport | null> {
  const lastPath = join(dir, '.orquestra', 'quality', 'last.json');
  try {
    const raw = await readFile(lastPath, 'utf8');
    const parsed = qualityReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Salva a medição em `.orquestra/quality/last.json`, movendo a anterior para `previous.json`. */
export async function saveReport(dir: string, report: QualityReport): Promise<void> {
  const qualityDir = join(dir, '.orquestra', 'quality');
  await mkdir(qualityDir, { recursive: true });
  const lastPath = join(qualityDir, 'last.json');
  const previousPath = join(qualityDir, 'previous.json');
  if (existsSync(lastPath)) {
    await rename(lastPath, previousPath);
  }
  await writeFile(lastPath, JSON.stringify(report, null, 2), 'utf8');
}
