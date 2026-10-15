import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No Windows, todo programa de console criado por um processo sem console (o host roda com windowsHide) ganha uma
 * janela nova que pisca. Toda chamada a child_process em packages/*\/src precisa passar `windowsHide: true`.
 */

const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function importedNames(source: string): { names: string[]; namespaces: string[] } {
  const names: string[] = [];
  const namespaces: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of match[1]!.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith('type ')) continue;
      const [original, alias] = trimmed.split(/\s+as\s+/);
      if (CHILD_PROCESS_FUNCTIONS.includes(original!)) names.push(alias ?? original!);
    }
  }
  for (const match of source.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"](?:node:)?child_process['"]/g)) namespaces.push(match[1]!);
  return { names, namespaces };
}

/** Texto da chamada, do "(" até o ")" correspondente, respeitando strings e templates. */
function callText(source: string, openIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return source.slice(openIndex, index + 1);
  }
  return source.slice(openIndex);
}

/** Chamadas a child_process sem `windowsHide: true`, como "linha:função". */
export function findUnhiddenCalls(source: string): string[] {
  const { names, namespaces } = importedNames(source);
  if (names.length === 0 && namespaces.length === 0) return [];
  const patterns = [
    ...names.map((name) => new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g')),
    ...namespaces.map((namespace) => new RegExp(`(?<![\\w$])${namespace}\\.(?:${CHILD_PROCESS_FUNCTIONS.join('|')})\\s*\\(`, 'g')),
  ];
  const problems: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index!;
      const lineStart = source.lastIndexOf('\n', start) + 1;
      const prefix = source.slice(lineStart, start);
      // Declaração de método ou função com o mesmo nome, não uma chamada.
      if (/\b(function|async|private|public|static)\s*$/.test(prefix)) continue;
      const open = source.indexOf('(', start);
      const text = callText(source, open);
      // "nome(args) {" ou "nome(args): Tipo {" é a declaração de um método, não uma chamada.
      if (/^\s*(:\s*[\w<>[\], |.]+\s*)?\{/.test(source.slice(open + text.length))) continue;
      if (!/windowsHide:\s*true/.test(text)) {
        problems.push(`${source.slice(0, start).split('\n').length}:${match[0].replace(/\s*\($/, '')}`);
      }
    }
  }
  return problems;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|tsx)$/.test(name)) found.push(path);
  }
  return found;
}

describe('windowsHide em chamadas a child_process', () => {
  it('detecta chamada sem windowsHide, em uma ou várias linhas, e ignora método com o mesmo nome', () => {
    const header = "import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';\n";
    expect(findUnhiddenCalls(`${header}execFileSync('where.exe', ['node'], { encoding: 'utf8' });`)).toEqual(['2:execFileSync']);
    expect(findUnhiddenCalls(`${header}execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true });`)).toEqual([]);
    expect(findUnhiddenCalls(`${header}const child = spawn(node, [script], {\n  cwd,\n  stdio: 'pipe',\n});`)).toEqual(['2:spawn']);
    expect(findUnhiddenCalls(`${header}const child = spawn(node, [script], {\n  cwd,\n  windowsHide: true,\n});`)).toEqual([]);
    expect(findUnhiddenCalls(`${header}class Host { spawn(spec) { return pty.spawn(spec.file); } }`)).toEqual([]);
    expect(findUnhiddenCalls("import { join } from 'node:path';\nspawn('x');")).toEqual([]);
  });

  it('trata aspas e parênteses dentro de strings sem perder o fim da chamada', () => {
    const source = "import { execSync } from 'node:child_process';\nexecSync(`for %I in (\"${dir}\") do @echo %~sI`, { shell: 'cmd.exe', windowsHide: true });";
    expect(findUnhiddenCalls(source)).toEqual([]);
    expect(findUnhiddenCalls(source.replace(', windowsHide: true', ''))).toEqual(['2:execSync']);
  });

  it('nenhuma chamada em packages/*/src deixa de passar windowsHide: true', () => {
    const packages = fileURLToPath(new URL('../../', import.meta.url));
    const problems: string[] = [];
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, 'src');
      try { if (!statSync(src).isDirectory()) continue; } catch { continue; }
      for (const file of sourceFiles(src)) {
        for (const problem of findUnhiddenCalls(readFileSync(file, 'utf8'))) problems.push(`${relative(packages, file).replaceAll('\\', '/')}:${problem}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
