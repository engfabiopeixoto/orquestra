import { describe, expect, it } from 'vitest';
import { evaluate, normalize, SCENARIOS } from '../src/scenarios.js';

const byId = (id: string) => {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`cenário ${id} não existe`);
  return scenario;
};

describe('SCENARIOS', () => {
  it('tem 20 cenários com ids únicos', () => {
    expect(SCENARIOS).toHaveLength(20);
    expect(new Set(SCENARIOS.map((item) => item.id)).size).toBe(20);
  });

  it('cobre multilinha, resposta longa, contexto e sequência rápida', () => {
    for (const id of ['multilinha', 'lista-80', 'guardar', 'lembrar', 'rapido']) expect(byId(id)).toBeDefined();
    expect(byId('multilinha').prompt).toContain('\n');
  });
});

describe('normalize', () => {
  it('remove ênfase markdown e ponto final', () => {
    expect(normalize('**BANANA**.')).toBe('BANANA');
    expect(normalize('  `391`  ')).toBe('391');
  });
});

describe('evaluate', () => {
  it('aceita a resposta correta e limpa', () => {
    expect(evaluate(byId('aritmetica'), '391')).toEqual({ correct: true, clean: true });
  });

  it('marca como suja a resposta com ANSI', () => {
    expect(evaluate(byId('aritmetica'), '\x1b[1m391\x1b[0m').clean).toBe(false);
  });

  it('marca como suja a resposta que ecoa o prompt', () => {
    const scenario = byId('aritmetica');
    expect(evaluate(scenario, `${scenario.prompt}\n391`).clean).toBe(false);
  });

  it('reprova resposta nula', () => {
    expect(evaluate(byId('aritmetica'), null)).toEqual({ correct: false, clean: false });
  });

  it('exige os 80 números na lista longa', () => {
    const full = Array.from({ length: 80 }, (_, index) => String(index + 1)).join('\n');
    expect(evaluate(byId('lista-80'), full).correct).toBe(true);
    expect(evaluate(byId('lista-80'), full.split('\n').slice(40).join('\n')).correct).toBe(false);
  });
});
