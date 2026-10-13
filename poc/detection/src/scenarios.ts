import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasAnsi } from './screen.js';

export type Scenario = {
  id: string;
  prompt: string;
  check: (answer: string) => boolean;
  /** O cenário precisa de ferramentas (ler, listar, escrever, rodar): só nele as permissões são aprovadas. */
  allowTools?: boolean;
  setup?: (workDir: string) => void;
};

export function normalize(answer: string): string {
  return answer.trim().replace(/^[*_`"]+/, '').replace(/[*_`".]+$/, '').trim();
}

const equals = (expected: string) => (answer: string) => normalize(answer) === expected;
const includes = (...parts: string[]) => (answer: string) => parts.every((part) => answer.includes(part));

export const SCENARIOS: Scenario[] = [
  { id: 'aritmetica', prompt: 'Quanto é 17 × 23? Responda só com o número.', check: equals('391') },
  { id: 'palavra', prompt: 'Responda apenas com a palavra BANANA, em maiúsculas.', check: equals('BANANA') },
  { id: 'acentos', prompt: 'Responda exatamente com o texto: ação, coração e São Paulo', check: includes('ação, coração e São Paulo') },
  {
    id: 'lista-80',
    prompt: 'Liste os números de 1 a 80, um por linha, sem nenhum outro texto.',
    check: (answer) => {
      const numbers = new Set(answer.split(/\s+/).map((token) => token.replace(/\D/g, '')));
      return Array.from({ length: 80 }, (_, index) => String(index + 1)).every((n) => numbers.has(n));
    },
  },
  {
    id: 'ler-arquivo',
    prompt: 'Leia o arquivo segredo.txt nesta pasta e responda só com o código que está nele.',
    setup: (workDir) => writeFileSync(join(workDir, 'segredo.txt'), 'codigo: TANGERINA-42\n'),
    allowTools: true,
    check: includes('TANGERINA-42'),
  },
  {
    id: 'contar-arquivos',
    prompt: 'Quantos arquivos nesta pasta têm nome começando com "item-" e extensão .txt? Responda só com o número.',
    setup: (workDir) => {
      writeFileSync(join(workDir, 'item-1.txt'), 'a');
      writeFileSync(join(workDir, 'item-2.txt'), 'b');
      writeFileSync(join(workDir, 'item-3.md'), 'c');
    },
    allowTools: true,
    check: equals('2'),
  },
  { id: 'multilinha', prompt: 'Some os números abaixo e responda só com o resultado:\n12\n30\n58', check: equals('100') },
  {
    id: 'especiais',
    prompt: 'Repita exatamente, sem aspas: "x < y && z > w" | $HOME %PATH%',
    check: includes('x < y && z > w', '$HOME', '%PATH%'),
  },
  {
    id: 'json',
    prompt: 'Responda só com este JSON, sem bloco de código: {"ok": true, "n": 7}',
    check: (answer) => {
      try {
        const parsed = JSON.parse(answer.trim().replace(/^```(json)?|```$/g, '').trim());
        return parsed.ok === true && parsed.n === 7;
      } catch {
        return false;
      }
    },
  },
  { id: 'codigo', prompt: 'Escreva uma função JavaScript chamada dobro que retorna x * 2. Só o código.', check: includes('dobro') },
  { id: 'guardar', prompt: 'Guarde a palavra-chave ORQUIDEA para depois. Responda só OK.', check: equals('OK') },
  { id: 'lembrar', prompt: 'Qual palavra-chave eu pedi para você guardar? Responda só com ela.', check: includes('ORQUIDEA') },
  { id: 'ponto', prompt: 'Responda com um único caractere: o ponto de interrogação.', check: (answer) => answer.trim() === '?' },
  {
    id: 'explicacao',
    prompt: 'Explique em três parágrafos curtos o que é um named pipe no Windows.',
    check: (answer) => answer.length > 200 && /pipe/i.test(answer),
  },
  {
    id: 'escrever-arquivo',
    prompt: 'Crie o arquivo resposta.txt nesta pasta contendo a palavra PRONTO e depois responda só FEITO.',
    allowTools: true,
    check: includes('FEITO'),
  },
  {
    id: 'rodar-comando',
    prompt: 'Rode o comando `node --version` e responda só com a versão que ele imprimir.',
    allowTools: true,
    check: (answer) => /v\d+\.\d+\.\d+/.test(answer),
  },
  { id: 'emoji', prompt: 'Responda só com: ✅ ok 🚀', check: includes('✅', '🚀') },
  { id: 'um', prompt: 'Responda só: 1', check: equals('1') },
  {
    id: 'tabela',
    prompt: 'Faça uma tabela markdown com as colunas nome e idade e duas linhas de exemplo. Só a tabela.',
    check: (answer) => (answer.match(/\|/g) ?? []).length >= 9,
  },
  { id: 'rapido', prompt: 'Quanto é 9 × 9? Só o número.', check: equals('81') },
];

export function evaluate(scenario: Scenario, answer: string | null): { correct: boolean; clean: boolean } {
  if (answer === null) return { correct: false, clean: false };
  const clean = !hasAnsi(answer) && !answer.includes(scenario.prompt);
  return { correct: scenario.check(answer), clean };
}
