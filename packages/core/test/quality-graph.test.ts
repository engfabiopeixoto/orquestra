import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportRef } from '../src/quality/source-metrics.js';
import {
  buildImportGraph,
  findCycles,
  readPathAliases,
  resolveImport,
} from '../src/quality/import-graph.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('import-graph e findCycles', () => {
  it('resolve imports relativos, extensão .js -> .ts, index e aliases', async () => {
    const files = new Set(['src/main.ts', 'src/x.ts', 'src/dir/index.tsx', 'src/u.ts']);
    const aliases = { baseUrl: '.', paths: { '@/*': ['src/*'] } };

    expect(resolveImport('src/main.ts', './x.js', files, aliases)).toBe('src/x.ts');
    expect(resolveImport('src/main.ts', './dir', files, aliases)).toBe('src/dir/index.tsx');
    expect(resolveImport('src/main.ts', '@/u', files, aliases)).toBe('src/u.ts');
    expect(resolveImport('src/main.ts', 'react', files, aliases)).toBeNull();
  });

  it('readPathAliases lê tsconfig.json com comentários', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-tsconfig-'));
    temps.push(dir);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      `{\n  // comentário\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["src/*"] }\n  }\n}\n`,
    );

    const aliases = await readPathAliases(dir);
    expect(aliases).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });

  it('quando tsconfig tem paths sem baseUrl, não resolve pacote externo contra arquivo na raiz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-tsconfig-nobase-'));
    temps.push(dir);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    );

    const aliases = await readPathAliases(dir);
    expect(aliases).toEqual({ paths: { '@/*': ['src/*'] } });

    const files = new Set(['src/main.ts', 'src/u.ts', 'react.ts']);
    expect(resolveImport('src/main.ts', '@/u', files, aliases)).toBe('src/u.ts');
    expect(resolveImport('src/main.ts', 'react', files, aliases)).toBeNull();
  });

  it('resolve imports usando apenas baseUrl quando paths não está definido', async () => {
    const files = new Set(['src/main.ts', 'src/utils/math.ts']);
    const aliases = { baseUrl: 'src', paths: {} };
    expect(resolveImport('src/main.ts', 'utils/math', files, aliases)).toBe('src/utils/math.ts');
    expect(resolveImport('src/main.ts', 'react', files, aliases)).toBeNull();
  });

  it('detecta ciclo em tempo de execução e ciclo apenas de tipos separadamente', () => {
    const files = new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const imports = new Map<string, ImportRef[]>([
      ['a.ts', [{ specifier: './b', typeOnly: false }]],
      ['b.ts', [{ specifier: './a', typeOnly: false }]],
      ['c.ts', [{ specifier: './d', typeOnly: true }]],
      ['d.ts', [{ specifier: './c', typeOnly: true }]],
    ]);

    const graph = buildImportGraph(imports, files, null);
    const cycles = findCycles(graph);
    expect(cycles).toContainEqual({ files: ['a.ts', 'b.ts'], typeOnly: false });
    expect(cycles).toContainEqual({ files: ['c.ts', 'd.ts'], typeOnly: true });
  });

  it('calcula fanIn e fanOut corretamente num grafo de 3 nós', () => {
    const files = new Set(['a.ts', 'b.ts', 'c.ts']);
    const imports = new Map<string, ImportRef[]>([
      ['a.ts', [{ specifier: './b', typeOnly: false }, { specifier: './c', typeOnly: false }]],
      ['b.ts', [{ specifier: './c', typeOnly: false }]],
      ['c.ts', []],
    ]);

    const graph = buildImportGraph(imports, files, null);
    expect(graph.fanOut.get('a.ts')).toBe(2);
    expect(graph.fanOut.get('b.ts')).toBe(1);
    expect(graph.fanOut.get('c.ts')).toBe(0);
    expect(graph.fanIn.get('a.ts')).toBe(0);
    expect(graph.fanIn.get('b.ts')).toBe(1);
    expect(graph.fanIn.get('c.ts')).toBe(2);
  });
});
