import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { childEnv } from './env.js';
import { nodePtyHost } from './pty-host.js';
import { resolveExecutable } from './resolve-exe.js';
import { Screen } from './screen.js';

export type SubscriptionUsage = {
  checkedAt: string;
  windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }>;
  credits: string | null;
  details: Array<{ label: string; value: string }>;
};
const percent = z.number().finite().min(0).max(100);
const claudeWindow = z.object({ utilization: percent, resets_at: z.string().nullable() });
const money = z.object({ amount_minor: z.number().finite(), currency: z.string(), exponent: z.number().int().min(0).max(6) });
const claudeUsage = z.object({
  five_hour: claudeWindow.nullable().optional(),
  seven_day: claudeWindow.nullable().optional(),
  seven_day_sonnet: claudeWindow.nullable().optional(),
  seven_day_opus: claudeWindow.nullable().optional(),
  extra_usage: z.object({ is_enabled: z.boolean() }).nullable().optional(),
  spend: z.object({ enabled: z.boolean(), used: money.nullable().optional(), balance: money.nullable().optional() }).nullable().optional(),
});
const formatMoney = (value: z.infer<typeof money>) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: value.currency }).format(value.amount_minor / 10 ** value.exponent);

export function parseClaudeUsage(input: unknown): SubscriptionUsage {
  const data = claudeUsage.parse(input);
  const windows = [
    ['5 h', data.five_hour], ['7 dias', data.seven_day], ['Sonnet · 7 dias', data.seven_day_sonnet], ['Opus · 7 dias', data.seven_day_opus],
  ] as const;
  const details: SubscriptionUsage['details'] = [];
  if (data.spend?.enabled && data.spend.used) details.push({ label: 'Uso extra no período', value: formatMoney(data.spend.used) });
  return {
    checkedAt: new Date().toISOString(),
    windows: windows.flatMap(([label, window]) => window ? [{ label, usedPercent: window.utilization, resetsAt: window.resets_at }] : []),
    credits: data.spend?.balance ? formatMoney(data.spend.balance) : data.extra_usage?.is_enabled === false ? 'Uso extra desativado' : null,
    details,
  };
}

/** The CLI's usage endpoint is not a public, versioned API. Keep credentials in the host only. */
export async function readClaudeUsage(deps: { fetch?: typeof fetch; credentialsFile?: string; env?: NodeJS.ProcessEnv } = {}): Promise<SubscriptionUsage> {
  const env = deps.env ?? process.env;
  let token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    try {
      const file = deps.credentialsFile ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
      const credentials = JSON.parse(await readFile(file, 'utf8'));
      token = credentials.claudeAiOauth?.accessToken;
    } catch { throw new Error('Entre no Claude Code com sua assinatura para consultar o uso.'); }
  }
  if (!token || typeof token !== 'string') throw new Error('A assinatura do Claude não está conectada. Entre no Claude Code.');
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch { throw new Error('Não foi possível consultar o Claude. Verifique a conexão e tente novamente.'); }
  if (response.status === 401 || response.status === 403) throw new Error('A sessão do Claude expirou ou não permite consultar uso. Entre novamente no Claude Code.');
  if (response.status === 429) throw new Error('O Claude limitou as consultas de uso. Aguarde alguns minutos.');
  if (!response.ok) throw new Error(`Consulta do Claude indisponível (HTTP ${response.status}).`);
  try { return parseClaudeUsage(await response.json()); }
  catch { throw new Error('O Claude retornou um formato de uso não reconhecido.'); }
}

/** Parse only quota fields, never account identity or terminal history. */
export function parseAgyUsage(text: string, creditsText: string, now = Date.now()): SubscriptionUsage {
  const lines = text.split('\n');
  const windows: SubscriptionUsage['windows'] = [];
  const details: SubscriptionUsage['details'] = [];
  let group = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === 'GEMINI MODELS') group = 'Gemini';
    if (line === 'CLAUDE AND GPT MODELS') group = 'Claude / GPT';
    if (!group || !/^(Weekly|Five Hour) Limit Remaining$/.test(line)) continue;
    const block = lines.slice(i + 1, i + 5).join('\n');
    const label = `${group} · ${line.startsWith('Weekly') ? '7 dias' : '5 h'}`;
    const remaining = block.match(/\]\s*(\d+(?:\.\d+)?)%/);
    if (!remaining) {
      if (/Disabled:/.test(block)) details.push({ label, value: 'Indisponível enquanto o limite semanal está esgotado' });
      continue;
    }
    const fraction = Number(remaining[1]);
    if (fraction < 0 || fraction > 100) continue;
    const reset = block.match(/Refreshes in\s+(?:(\d+)h)?\s*(?:(\d+)m)?/);
    const minutes = reset ? Number(reset[1] ?? 0) * 60 + Number(reset[2] ?? 0) : 0;
    windows.push({ label, usedPercent: Math.round((100 - fraction) * 100) / 100, resetsAt: minutes ? new Date(now + minutes * 60000).toISOString() : null });
  }
  if (!windows.length) throw new Error('Não foi possível ler as cotas do Antigravity. Entre no agy e tente novamente.');
  const balance = creditsText.match(/Remaining AI Credits:\s*([^\n]+)/)?.[1]?.trim();
  const credits = balance && /not enabled/i.test(balance) ? 'Créditos de IA desativados' : balance && /^[\d,.]+(?:\s*AI Credits)?$/i.test(balance) ? balance : null;
  return { checkedAt: new Date(now).toISOString(), windows, credits, details };
}

/** Run native slash commands in a separate PTY; never inject into an active agent or send inference. */
export async function readAgyUsage(cwd: string, signal?: AbortSignal): Promise<SubscriptionUsage> {
  const executable = resolveExecutable('agy');
  const env = childEnv(process.env);
  delete env.ORQ_PIPE;
  delete env.ORQ_TOKEN;
  const screen = new Screen(140, 80);
  const pty = nodePtyHost.spawn({ file: executable.file, args: executable.argsPrefix, cwd, env, cols: 140, rows: 80 });
  let failure: Error | null = null;
  let stopped = false;
  pty.onError(() => { failure = new Error('A consulta do Antigravity foi interrompida.'); });
  pty.onExit(() => { stopped = true; });
  screen.onReply((data) => { if (!stopped) pty.write(data); });
  pty.onData((data) => { if (!stopped) void screen.write(data); });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (matches: (text: string) => boolean, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Consulta do Antigravity cancelada.');
      const text = screen.visible();
      if (failure || stopped) throw failure ?? new Error('O Antigravity encerrou a consulta.');
      if (/Do you trust|Allow access/.test(text)) throw new Error('Autorize esta pasta ao abrir um terminal agy e consulte novamente.');
      if (/Sign in to|Log in to/.test(text)) throw new Error('Entre na sua conta no agy e consulte novamente.');
      if (matches(text)) return text;
      await pause(100);
    }
    throw new Error('A consulta do Antigravity demorou demais. Tente novamente.');
  };
  const isPrompt = (text: string) => /Antigravity CLI/.test(text) && /^\s*>\s*$/m.test(text);
  const command = async (name: '/usage' | '/credits') => {
    pty.write(name);
    await pause(250);
    pty.write('\r');
  };
  try {
    await waitFor(isPrompt);
    await command('/usage');
    const quotas = await waitFor((text) => /Models & Quota/.test(text) && /CLAUDE AND GPT MODELS/.test(text) && /\]\s*\d+(?:\.\d+)?%/.test(text));
    pty.write('\x1b');
    await waitFor((text) => isPrompt(text) && !/Models & Quota/.test(text));
    await command('/credits');
    const credits = await waitFor((text) => /Remaining AI Credits:/.test(text));
    return parseAgyUsage(quotas, credits);
  } finally {
    await pty.kill();
    stopped = true;
    screen.dispose();
  }
}
