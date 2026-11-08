import { describe, expect, it } from 'vitest';
import { formatProviderUsage, formatResetTime, formatUsageSummary, formatWindowLabel } from '../src/usage-format.js';

describe('formatação do resumo de assinaturas (usage-format)', () => {
  const fixedNow = new Date('2026-11-08T12:00:00.000Z').getTime();

  it('formatResetTime formata horas e minutos relativos quando menor que 24h', () => {
    // 1h20 à frente (80 minutos)
    const in80m = new Date(fixedNow + 80 * 60000).toISOString();
    expect(formatResetTime(in80m, fixedNow)).toBe('em 1h20');

    // 45 minutos à frente
    const in45m = new Date(fixedNow + 45 * 60000).toISOString();
    expect(formatResetTime(in45m, fixedNow)).toBe('em 45m');

    // 2 horas exatas à frente
    const in2h = new Date(fixedNow + 120 * 60000).toISOString();
    expect(formatResetTime(in2h, fixedNow)).toBe('em 2h');
  });

  it('formatResetTime formata dia da semana e horário quando maior ou igual a 24h', () => {
    // Sexta-feira às 14:00 UTC (2026-11-13T14:00:00.000Z)
    const target = new Date('2026-11-13T14:00:00.000Z');
    const resetTime = target.toISOString();
    const result = formatResetTime(resetTime, fixedNow);
    // Deve conter o dia da semana ('sex') e o horário ('14:00' no horário da data)
    expect(result).toMatch(/^(?:dom|seg|ter|qua|qui|sex|sáb)\s+\d{2}:\d{2}$/);
    const expectedWeekday = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][target.getDay()];
    const expectedHour = target.getHours().toString().padStart(2, '0');
    const expectedMin = target.getMinutes().toString().padStart(2, '0');
    expect(result).toBe(`${expectedWeekday} ${expectedHour}:${expectedMin}`);
  });

  it('formatWindowLabel normaliza labels conhecidos de Claude, Codex e Agy', () => {
    expect(formatWindowLabel('5 h')).toBe('sessão 5h');
    expect(formatWindowLabel('7 dias')).toBe('semanal');
    expect(formatWindowLabel('Sessão')).toBe('sessão 5h');
    expect(formatWindowLabel('Semanal')).toBe('semanal');
    expect(formatWindowLabel('Sonnet · 7 dias')).toBe('Sonnet · semanal');
    expect(formatWindowLabel('Opus · 7 dias')).toBe('Opus · semanal');
    expect(formatWindowLabel('Gemini · 5 h')).toBe('Gemini · sessão 5h');
    expect(formatWindowLabel('Gemini · 7 dias')).toBe('Gemini · semanal');
    expect(formatWindowLabel('Claude / GPT · 5 h')).toBe('Claude / GPT · sessão 5h');
  });

  it('formatProviderUsage formata resumo no padrão esperado', () => {
    const in80m = new Date(fixedNow + 80 * 60000).toISOString();
    const target = new Date('2026-11-13T14:00:00.000Z');
    const expectedReset = formatResetTime(target.toISOString(), fixedNow);

    const line = formatProviderUsage({
      provider: 'claude',
      usage: {
        checkedAt: new Date(fixedNow).toISOString(),
        windows: [
          { label: '5 h', usedPercent: 82, resetsAt: in80m },
          { label: '7 dias', usedPercent: 40, resetsAt: target.toISOString() },
        ],
        credits: null,
        details: [],
      },
      error: null,
    }, fixedNow);

    expect(line).toBe(`claude  sessão 5h: 82% usado, renova em 1h20 | semanal: 40% usado, renova ${expectedReset}`);
  });

  it('formatProviderUsage inclui créditos se presentes', () => {
    const in2h = new Date(fixedNow + 120 * 60000).toISOString();
    const line = formatProviderUsage({
      provider: 'agy',
      usage: {
        checkedAt: new Date(fixedNow).toISOString(),
        windows: [{ label: 'Gemini · 5 h', usedPercent: 10, resetsAt: in2h }],
        credits: '50.00 AI Credits',
        details: [],
      },
      error: null,
    }, fixedNow);

    expect(line).toBe('agy     Gemini · sessão 5h: 10% usado, renova em 2h | créditos: 50.00 AI Credits');
  });

  it('formatProviderUsage exibe erro do provedor sem derrubar os dados', () => {
    const line = formatProviderUsage({
      provider: 'agy',
      usage: null,
      error: 'Entre na sua conta no agy e consulte novamente.',
    });

    expect(line).toBe('agy     erro: Entre na sua conta no agy e consulte novamente.');
  });

  it('formatUsageSummary combina os provedores linha a linha', () => {
    const in80m = new Date(fixedNow + 80 * 60000).toISOString();
    const summary = formatUsageSummary([
      {
        provider: 'claude',
        usage: { checkedAt: new Date(fixedNow).toISOString(), windows: [{ label: '5 h', usedPercent: 50, resetsAt: in80m }], credits: null, details: [] },
        error: null,
      },
      {
        provider: 'codex',
        usage: { checkedAt: new Date(fixedNow).toISOString(), windows: [{ label: '7 dias', usedPercent: 20, resetsAt: null }], credits: null, details: [] },
        error: null,
      },
      {
        provider: 'agy',
        usage: null,
        error: 'Falha temporária',
      },
    ], fixedNow);

    const lines = summary.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('claude  sessão 5h: 50% usado, renova em 1h20');
    expect(lines[1]).toBe('codex   semanal: 20% usado');
    expect(lines[2]).toBe('agy     erro: Falha temporária');
  });
});
