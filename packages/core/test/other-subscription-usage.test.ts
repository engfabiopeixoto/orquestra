import { describe, expect, it, vi } from 'vitest';
import { parseAgyUsage, parseClaudeUsage, readClaudeUsage } from '../src/other-subscription-usage.js';

describe('assinaturas Claude e Antigravity', () => {
  it('Claude separa limites, uso extra desativado e saldo desconhecido', () => {
    const usage = parseClaudeUsage({ five_hour: { utilization: 2, resets_at: '2026-10-13T02:40:00Z' }, seven_day: { utilization: 98, resets_at: null }, extra_usage: { is_enabled: false } });
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([2, 98]);
    expect(usage.credits).toBe('Uso extra desativado');
    expect(parseClaudeUsage({}).credits).toBeNull();
  });
  it('Claude formata unidades monetárias menores respeitando a moeda', () => {
    const usage = parseClaudeUsage({ spend: { enabled: true, used: { amount_minor: 1234, currency: 'USD', exponent: 2 }, balance: { amount_minor: 5000, currency: 'USD', exponent: 2 } } });
    expect(usage.credits).toContain('50,00');
    expect(usage.details[0]?.value).toContain('12,34');
  });
  it('Antigravity converte cota restante em uso e preserva grupos separados', () => {
    const usage = parseAgyUsage(`GEMINI MODELS
Weekly Limit Remaining
[████░] 46.71%
Refreshes in 80h 25m
Five Hour Limit Remaining
[█████] 100.00%
Quota available
CLAUDE AND GPT MODELS
Weekly Limit Remaining
[░░░░░] 0.00%
Refreshes in 95h 42m
Five Hour Limit Remaining
Disabled: You have hit your weekly limit`, 'Remaining AI Credits: AI Credits not enabled (enable in /settings)', 0);
    expect(usage.windows.map((window) => [window.label, window.usedPercent])).toEqual([['Gemini · 7 dias', 53.29], ['Gemini · 5 h', 0], ['Claude / GPT · 7 dias', 100]]);
    expect(usage.windows[0]?.resetsAt).toBe(new Date((80 * 60 + 25) * 60000).toISOString());
    expect(usage.details[0]?.label).toBe('Claude / GPT · 5 h');
    expect(usage.credits).toBe('Créditos de IA desativados');
  });
  it('não inventa cota ao encontrar tela inesperada', () => {
    expect(() => parseAgyUsage('Faça login', '')).toThrow(/Não foi possível ler/);
  });
  it('consulta Claude somente no host e não expõe o token nos erros', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(readClaudeUsage({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-sentinel' }, fetch: fetcher })).rejects.toThrow(/sessão do Claude expirou/);
    expect(fetcher).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-sentinel' }), redirect: 'error' }));
  });
});
