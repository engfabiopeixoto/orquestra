import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { QualityCycle } from '@orquestra/shared';
import ts from 'typescript';
import type { ImportRef } from './source-metrics.js';

export const ANALYZED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export interface PathAliases {
  baseUrl?: string;
  paths: Record<string, string[]>;
}

export interface ImportGraph {
  edges: Map<string, Map<string, boolean>>;
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

const ESM_TS_MAP: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.ts', '.jsx', '.js'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

function normalizePosix(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/\/+$/, '');
  return normalized === './' ? '.' : normalized;
}

/** Lê `baseUrl` e `paths` do `tsconfig.json` da raiz, aceitando JSON com comentários. */
export async function readPathAliases(dir: string): Promise<PathAliases | null> {
  const tsconfigPath = join(dir, 'tsconfig.json');
  let raw: string;
  try {
    raw = await readFile(tsconfigPath, 'utf8');
  } catch {
    return null;
  }

  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, raw);
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object') return null;

  const opts = (parsed.config as { compilerOptions?: unknown }).compilerOptions;
  if (!opts || typeof opts !== 'object') return null;

  const { baseUrl: rawBaseUrl, paths: rawPaths } = opts as { baseUrl?: unknown; paths?: unknown };
  const hasBaseUrl = typeof rawBaseUrl === 'string' && rawBaseUrl.length > 0;
  const hasPaths = rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths);
  if (!hasBaseUrl && !hasPaths) return null;

  const baseUrl = hasBaseUrl ? normalizePosix(rawBaseUrl) : undefined;
  const paths: Record<string, string[]> = {};
  if (hasPaths) {
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const valid = targets.filter((t): t is string => typeof t === 'string');
      if (valid.length > 0) paths[pattern] = valid.map((t) => t.replaceAll('\\', '/'));
    }
  }

  return baseUrl !== undefined ? { baseUrl, paths } : { paths };
}

function probeCandidates(baseInput: string, files: ReadonlySet<string>): string | null {
  const base = normalizePosix(baseInput).replace(/^\.\//, '');
  if (!base || base.startsWith('..')) return null;
  if (files.has(base)) return base;

  const lastDot = base.lastIndexOf('.');
  const lastSlash = base.lastIndexOf('/');
  if (lastDot > lastSlash) {
    const ext = base.slice(lastDot).toLowerCase();
    const stem = base.slice(0, lastDot);
    const mapped = ESM_TS_MAP[ext];
    if (mapped) {
      for (const candidateExt of mapped) {
        const candidate = `${stem}${candidateExt}`;
        if (files.has(candidate)) return candidate;
      }
    }
  }

  for (const ext of ANALYZED_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (files.has(candidate)) return candidate;
  }

  const indexPrefix = base === '.' ? 'index' : `${base}/index`;
  for (const ext of ANALYZED_EXTENSIONS) {
    const candidate = `${indexPrefix}${ext}`;
    if (files.has(candidate)) return candidate;
  }

  return null;
}

function resolveAliasCandidates(specifier: string, aliases: PathAliases): string[] {
  const exact = aliases.paths[specifier];
  const results: string[] = [];
  const baseUrl = aliases.baseUrl ?? '.';
  const joinBase = (target: string) =>
    baseUrl === '.' ? target : posix.join(baseUrl, target);

  if (exact) {
    for (const target of exact) results.push(joinBase(target));
    return results;
  }

  const wildcardMatches: Array<{ prefixLen: number; targets: string[]; matched: string }> = [];
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length) continue;
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    wildcardMatches.push({ prefixLen: prefix.length, targets, matched });
  }

  wildcardMatches.sort((a, b) => b.prefixLen - a.prefixLen);
  for (const match of wildcardMatches) {
    for (const target of match.targets) {
      results.push(joinBase(target.replaceAll('*', match.matched)));
    }
  }
  return results;
}

/** Resolve um especificador relativo ou alias do `tsconfig.json` para um arquivo conhecido do projeto. */
export function resolveImport(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  aliases: PathAliases | null,
): string | null {
  const clean = specifier.split(/[?#]/)[0] ?? '';
  if (!clean) return null;

  const isRelative =
    clean.startsWith('./') || clean.startsWith('../') || clean === '.' || clean === '..';
  if (isRelative) {
    const base = posix.join(posix.dirname(from.replaceAll('\\', '/')), clean);
    return probeCandidates(base, files);
  }

  if (!aliases) return null;
  for (const candidate of resolveAliasCandidates(clean, aliases)) {
    const resolved = probeCandidates(candidate, files);
    if (resolved) return resolved;
  }
  if (aliases.baseUrl !== undefined) {
    const baseCandidate = aliases.baseUrl === '.' ? clean : posix.join(aliases.baseUrl, clean);
    return probeCandidates(baseCandidate, files);
  }
  return null;
}

/** Constrói o grafo direcionado de imports internos e calcula `fanIn` e `fanOut` de cada arquivo. */
export function buildImportGraph(
  imports: Map<string, ImportRef[]>,
  files: ReadonlySet<string>,
  aliases: PathAliases | null,
): ImportGraph {
  const edges = new Map<string, Map<string, boolean>>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const file of files) {
    edges.set(file, new Map());
    fanIn.set(file, 0);
    fanOut.set(file, 0);
  }

  for (const [from, refs] of imports) {
    const outMap = edges.get(from);
    if (!outMap) continue;
    for (const ref of refs) {
      const target = resolveImport(from, ref.specifier, files, aliases);
      if (!target) continue;
      const previous = outMap.get(target);
      outMap.set(target, previous === undefined ? ref.typeOnly : previous && ref.typeOnly);
    }
  }

  for (const [from, targets] of edges) {
    fanOut.set(from, targets.size);
    for (const target of targets.keys()) {
      fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
    }
  }

  return { edges, fanIn, fanOut };
}

function tarjanScc(nodes: string[], neighborsOf: (node: string) => string[]): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const sccStack: string[] = [];
  const sccs: string[][] = [];

  type Frame = { node: string; parent: string | null; neighbors: string[]; cursor: number };

  for (const start of nodes) {
    if (index.has(start)) continue;
    const callStack: Frame[] = [{ node: start, parent: null, neighbors: neighborsOf(start), cursor: 0 }];
    index.set(start, nextIndex);
    lowlink.set(start, nextIndex);
    nextIndex++;
    sccStack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      if (frame.cursor < frame.neighbors.length) {
        const next = frame.neighbors[frame.cursor++]!;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          lowlink.set(next, nextIndex);
          nextIndex++;
          sccStack.push(next);
          onStack.add(next);
          callStack.push({ node: next, parent: frame.node, neighbors: neighborsOf(next), cursor: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      callStack.pop();
      if (frame.parent !== null) {
        lowlink.set(frame.parent, Math.min(lowlink.get(frame.parent)!, lowlink.get(frame.node)!));
      }

      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        while (true) {
          const member = sccStack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        sccs.push(component);
      }
    }
  }

  return sccs;
}

/** Detecta ciclos em tempo de execução e ciclos exclusivos de tipos pelo algoritmo de Tarjan. */
export function findCycles(graph: ImportGraph): QualityCycle[] {
  const nodes = [...graph.edges.keys()].sort();
  const runtimeNeighbors = (node: string): string[] => {
    const targets = graph.edges.get(node);
    if (!targets) return [];
    const list: string[] = [];
    for (const [target, typeOnly] of targets) {
      if (!typeOnly) list.push(target);
    }
    return list.sort();
  };

  const allNeighbors = (node: string): string[] => {
    const targets = graph.edges.get(node);
    return targets ? [...targets.keys()].sort() : [];
  };

  const cycles: QualityCycle[] = [];
  const runtimeCycleFiles = new Set<string>();

  for (const scc of tarjanScc(nodes, runtimeNeighbors)) {
    const isSelfLoop = scc.length === 1 && runtimeNeighbors(scc[0]!).includes(scc[0]!);
    if (scc.length > 1 || isSelfLoop) {
      const sorted = [...scc].sort();
      for (const file of sorted) runtimeCycleFiles.add(file);
      cycles.push({ files: sorted, typeOnly: false });
    }
  }

  for (const scc of tarjanScc(nodes, allNeighbors)) {
    const isSelfLoop = scc.length === 1 && allNeighbors(scc[0]!).includes(scc[0]!);
    if ((scc.length > 1 || isSelfLoop) && scc.every((file) => !runtimeCycleFiles.has(file))) {
      cycles.push({ files: [...scc].sort(), typeOnly: true });
    }
  }

  cycles.sort((a, b) => Number(a.typeOnly) - Number(b.typeOnly) || a.files[0]!.localeCompare(b.files[0]!));
  return cycles;
}
