import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/quality/source-metrics.js';

describe('analyzeSource (tamanho, complexidade e imports)', () => {
  it('mede função vazia com complexidade 1 e profundidade 0', () => {
    const result = analyzeSource('src/a.ts', 'function vazia() {}\n');
    expect(result.functions).toEqual([
      { line: 1, name: 'vazia', complexity: 1, depth: 0, loc: 1 },
    ]);
  });

  it('calcula complexidade ciclomática e profundidade ignorando incremento no else if', () => {
    const code = [
      'function fluxo(a: boolean, b: boolean, c: boolean, x: number | null, y: number) {',
      '  if (a && b) {',
      '  } else if (c) {',
      '  }',
      '  const v = x ?? y;',
      '  for (let i = 0; i < v; i++) {',
      '    if (i > 1) return i;',
      '  }',
      '  return 0;',
      '}',
    ].join('\n');

    const result = analyzeSource('src/fluxo.ts', code);
    expect(result.functions).toHaveLength(1);
    // 1 base + if + && + else if + ?? + for + if = 7; for -> if dá profundidade 2
    expect(result.functions[0]).toMatchObject({
      name: 'fluxo',
      line: 1,
      complexity: 7,
      depth: 2,
    });
  });

  it('conta switch com 3 cases e 1 default como complexidade 4', () => {
    const code = [
      'function escolha(n: number) {',
      '  switch (n) {',
      '    case 1: return "a";',
      '    case 2: return "b";',
      '    case 3: return "c";',
      '    default: return "z";',
      '  }',
      '}',
    ].join('\n');

    const result = analyzeSource('src/sw.ts', code);
    expect(result.functions[0]).toMatchObject({ name: 'escolha', complexity: 4, depth: 1 });
  });

  it('mede arrow interna separada sem somar seus desvios na função externa', () => {
    const code = [
      'function externa(items: number[]) {',
      '  const handler = () => {',
      '    if (items.length > 0 && items[0] > 1) return true;',
      '    return false;',
      '  };',
      '  return handler();',
      '}',
    ].join('\n');

    const result = analyzeSource('src/nested.ts', code);
    expect(result.functions).toHaveLength(2);
    expect(result.functions[0]).toMatchObject({ name: 'externa', complexity: 1, depth: 0 });
    expect(result.functions[1]).toMatchObject({ name: 'handler', complexity: 3, depth: 1 });
  });

  it('conta apenas linhas com tokens reais de código e ignora comentários e linhas em branco', () => {
    const code = [
      '// comentário de linha',
      '',
      '/* bloco',
      '   comentário',
      '   de 3 linhas */',
      'const a = 1;',
      '',
      'const b = 2;',
      'export { a, b };',
    ].join('\n');

    const result = analyzeSource('src/loc.ts', code);
    expect(result.loc).toBe(3);
  });

  it('conta todas as linhas de template literals e strings multilinha', () => {
    const code = [
      'const msg = `linha 1',
      'linha 2',
      'linha 3`;',
    ].join('\n');

    const result = analyzeSource('src/tpl.ts', code);
    expect(result.loc).toBe(3);
  });

  it('coleta imports estáticos, type-only, export from, require e import dinâmico', () => {
    const code = [
      "import type { A } from './a';",
      "import { type B } from './b';",
      "import { C } from './c';",
      "export type { D } from './d-type';",
      "export { E } from './e-val';",
      "const req = require('./d');",
      "async function load() { return import('./e'); }",
    ].join('\n');

    const result = analyzeSource('src/imports.ts', code);
    expect(result.imports).toEqual([
      { specifier: './a', typeOnly: true },
      { specifier: './b', typeOnly: true },
      { specifier: './c', typeOnly: false },
      { specifier: './d-type', typeOnly: true },
      { specifier: './e-val', typeOnly: false },
      { specifier: './d', typeOnly: false },
      { specifier: './e', typeOnly: false },
    ]);
  });

  it('não lança exceção em arquivo com erro de sintaxe e retorna loc > 0', () => {
    const result = analyzeSource('src/broken.tsx', 'const ok = <div>oi</div>;\nfunction (\n');
    expect(result.loc).toBeGreaterThan(0);
  });

  it('conta loc corretamente após template literal com interpolação ${...}', () => {
    const code = [
      'export function render(x: string) {',
      '  const s = `hi ${x}!`;',
      '',
      '  // comentário após template',
      '  return s;',
      '}',
      '',
      '// outro comentário',
      'export const ok = 1;',
    ].join('\n');

    const result = analyzeSource('src/tpl-expr.ts', code);
    expect(result.loc).toBe(5);
    expect(result.functions[0]).toMatchObject({ name: 'render', loc: 4 });
  });

  it('mede arrow em propriedade de classe, try/catch e ignora optional chaining ?.', () => {
    const code = [
      'class Widget {',
      '  handler = (obj?: { a?: { b?: number } }) => {',
      '    try {',
      '      return obj?.a?.b;',
      '    } catch {',
      '      return 0;',
      '    }',
      '  };',
      '}',
    ].join('\n');

    const result = analyzeSource('src/widget.ts', code);
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]).toMatchObject({ name: 'handler', complexity: 2, depth: 1 });
  });

  it('conta desvios em valores padrão de parâmetros na complexidade da função', () => {
    const code = 'function padrao(a: boolean, b: boolean, x = a && b ? 1 : 2) { return x; }\n';
    const result = analyzeSource('src/defaults.ts', code);
    expect(result.functions[0]).toMatchObject({ name: 'padrao', complexity: 3, depth: 0 });
  });
});
