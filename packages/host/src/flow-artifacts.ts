import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { flowArtifactSchema, flowGraphSchema, flowRunSchema, jsonValueSchema, type FlowArtifact, type FlowDataType, type FlowGraph, type FlowRun, type JsonValue } from '@orquestra/shared';

export const flowHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function projectPath(root: string, path: string, write = false): string {
  if (!path || isAbsolute(path)) throw new Error('Use um caminho relativo à pasta do workspace.');
  const base = realpathSync.native(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('O arquivo deve permanecer dentro do workspace.');
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  const canonical = realpathSync.native(ancestor);
  const ancestorRel = relative(base, canonical);
  if (ancestorRel === '..' || ancestorRel.startsWith('..' + sep) || isAbsolute(ancestorRel)) throw new Error('O caminho atravessa um link para fora do workspace.');
  if (!write && (!existsSync(target) || !statSync(target).isFile())) throw new Error('Arquivo não encontrado no workspace.');
  return target;
}
export type FlowRecord = { graph: FlowGraph; run: FlowRun };
type CacheEntry = { usedAt: number; outputs: Record<string, FlowArtifact> };

export class FlowArtifacts {
  private readonly root: string;
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly project: string) {
    this.root = projectPath(project, '.orquestra/flow', true);
    mkdirSync(join(this.root, 'objects'), { recursive: true }); mkdirSync(join(this.root, 'runs'), { recursive: true });
    try {
      if (statSync(join(this.root, 'cache.json')).size > 2 * 1024 * 1024) throw new Error('Cache excede o limite.');
      const data = JSON.parse(readFileSync(join(this.root, 'cache.json'), 'utf8'));
      for (const [key, entry] of Object.entries(data).slice(-128)) if (/^[a-f0-9]{64}$/.test(key)) {
        const value = entry as CacheEntry;
        this.cache.set(key, { usedAt: Number(value.usedAt) || 0, outputs: Object.fromEntries(Object.entries(value.outputs).map(([name, artifact]) => [name, flowArtifactSchema.parse(artifact)])) });
      }
    } catch { /* absent or damaged cache is recomputed */ }
  }
  put(value: JsonValue, type: FlowDataType): FlowArtifact {
    const text = stableJson(value);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Resultado excede 4 MiB. Use referência a arquivo.');
    const hash = flowHash(text), file = join(this.root, 'objects', hash + '.json');
    projectPath(this.project, relative(this.project, file), true);
    if (!existsSync(file) || statSync(file).size !== Buffer.byteLength(text) || flowHash(readFileSync(file)) !== hash) this.atomic(file, text);
    return { hash, bytes: Buffer.byteLength(text), preview: text.slice(0, 512), type };
  }
  read(artifact: FlowArtifact): JsonValue {
    const validated = flowArtifactSchema.parse(artifact);
    const file = join(this.root, 'objects', validated.hash + '.json');
    projectPath(this.project, relative(this.project, file));
    if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Artefato excede o limite de leitura.');
    const text = readFileSync(file, 'utf8');
    if (flowHash(text) !== artifact.hash) throw new Error('O artefato foi alterado. Execute novamente para reconstruí-lo.');
    return jsonValueSchema.parse(JSON.parse(text));
  }
  cached(key: string): Record<string, FlowArtifact> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    try { for (const artifact of Object.values(entry.outputs)) this.read(artifact); } catch { this.cache.delete(key); return null; }
    entry.usedAt = Date.now(); return entry.outputs;
  }
  remember(key: string, outputs: Record<string, FlowArtifact>): void {
    this.cache.set(key, { outputs, usedAt: Date.now() });
    const sorted = [...this.cache].sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (sorted.length > 128 || Buffer.byteLength(JSON.stringify(Object.fromEntries(sorted))) > 2 * 1024 * 1024) { const removed = sorted.shift(); if (removed) this.cache.delete(removed[0]); else break; }
    this.atomic(join(this.root, 'cache.json'), JSON.stringify(Object.fromEntries(this.cache)));
  }
  record(graph: FlowGraph, run: FlowRun): void {
    this.atomic(join(this.root, 'runs', run.id + '.json'), JSON.stringify({ graph, run }));
    const files = readdirSync(join(this.root, 'runs')).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).sort((a, b) => statSync(join(this.root, 'runs', b)).mtimeMs - statSync(join(this.root, 'runs', a)).mtimeMs);
    for (const file of files.slice(20)) rmSync(join(this.root, 'runs', file), { force: true });
  }
  latest(): FlowRecord | null {
    const name = readdirSync(join(this.root, 'runs')).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).sort((a, b) => statSync(join(this.root, 'runs', b)).mtimeMs - statSync(join(this.root, 'runs', a)).mtimeMs)[0];
    return name ? this.get(name.slice(0, -5)) : null;
  }
  get(id: string): FlowRecord | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    try {
      const file = projectPath(this.project, relative(this.project, join(this.root, 'runs', id + '.json')));
      if (statSync(file).size > 12 * 1024 * 1024) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8')); return { graph: flowGraphSchema.parse(parsed.graph), run: flowRunSchema.parse(parsed.run) };
    } catch { return null; }
  }
  history(): FlowRun[] {
    return readdirSync(join(this.root, 'runs')).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).sort((a, b) => statSync(join(this.root, 'runs', b)).mtimeMs - statSync(join(this.root, 'runs', a)).mtimeMs).slice(0, 20).flatMap((name) => { const record = this.get(name.slice(0, -5)); return record ? [{ ...record.run, results: {} }] : []; });
  }
  private atomic(file: string, text: string): void { projectPath(this.project, relative(this.project, file), true); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', text, 'utf8'); renameSync(file + '.tmp', file); }
  exportPreview(artifact: FlowArtifact, path: string) {
    const file = projectPath(this.project, path, true);
    const rel = relative(this.project, file).replace(/\\/g, '/');
    if (rel.toLowerCase().startsWith('.orquestra/')) throw new Error('Escolha uma pasta de resultados fora dos arquivos internos .orquestra.');
    const value = this.read(artifact);
    const next = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    if (existsSync(file) && statSync(file).size > 4 * 1024 * 1024) throw new Error('O arquivo existente excede o limite de comparação. Escolha outro destino.');
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
    return { path: rel, next, previous, previousHash: previous === null ? null : flowHash(previous), nextHash: flowHash(next) };
  }
  exportApply(artifact: FlowArtifact, input: { path: string; previousHash: string | null; nextHash: string }): { path: string } {
    const preview = this.exportPreview(artifact, input.path);
    if (preview.previousHash !== input.previousHash || preview.nextHash !== input.nextHash) throw new Error('O arquivo ou resultado mudou desde a prévia. Confira a comparação novamente.');
    this.atomic(projectPath(this.project, preview.path, true), preview.next);
    return { path: preview.path };
  }
}
