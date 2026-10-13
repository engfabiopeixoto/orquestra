import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { resolveExecutable } from './resolve-exe.js';

const windowSchema = z.object({ usedPercent: z.number().finite().min(0).max(100), windowDurationMins: z.number().nullable().optional(), resetsAt: z.number().nullable().optional() });
const limitsSchema = z.object({ primary: windowSchema.nullable().optional(), secondary: windowSchema.nullable().optional(), credits: z.object({ hasCredits: z.boolean().optional(), unlimited: z.boolean().optional(), balance: z.string().nullable().optional() }).nullable().optional() });

/** Read-only RPC: never starts an inference turn or exposes authentication tokens. */
export async function readCodexUsage() {
  const executable = resolveExecutable('codex');
  const child = spawn(executable.file, [...executable.argsPrefix, 'app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let id = 0;
  let closed = false;
  const closeChild = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    } else child.kill();
  };
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', () => fail(new Error('Não foi possível iniciar o Codex.')));
  child.on('exit', () => fail(new Error('O Codex encerrou a consulta de uso.')));
  child.stdin.on('error', () => fail(new Error('A conexão com o Codex foi encerrada.')));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error('Uso indisponível. Entre no Codex com sua conta ChatGPT e tente novamente.'));
    else request.resolve(message.result);
  });
  const request = (method: string, params: unknown = {}) => new Promise<unknown>((resolve, reject) => {
    const nextId = ++id;
    pending.set(nextId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: nextId, method, params })}\n`);
  });
  const timeout = setTimeout(() => {
    fail(new Error('A consulta de uso demorou demais. Tente novamente.'));
    void closeChild();
  }, 15000);
  try {
    await request('initialize', { clientInfo: { name: 'orquestra', title: 'Orquestra', version: '0.2.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const result = await request('account/rateLimits/read') as { rateLimits?: unknown };
    const limits = limitsSchema.parse(result.rateLimits);
    return {
      checkedAt: new Date().toISOString(),
      windows: [limits.primary, limits.secondary].flatMap((window, index) => window ? [{
        label: window.windowDurationMins ? `${window.windowDurationMins >= 1440 ? `${Math.round(window.windowDurationMins / 1440)} dias` : `${window.windowDurationMins / 60} h`}` : index === 0 ? 'Sessão' : 'Semanal',
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
      }] : []),
      credits: limits.credits?.unlimited ? 'Ilimitados' : limits.credits?.balance ?? null,
      details: [],
    };
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    await closeChild();
  }
}
