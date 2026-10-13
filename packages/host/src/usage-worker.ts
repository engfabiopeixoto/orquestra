import { execFile, spawn } from 'node:child_process';
import { childEnv } from '@orquestra/core';
import { subscriptionUsageSchema } from '@orquestra/shared';
import type { SubscriptionUsage } from '@orquestra/core';

/** A native ConPTY startup may block synchronously; keep it outside the workspace host. */
export function readAgyUsageIsolated(opts: { script: string; cwd: string; signal: AbortSignal; onStart(pid: number): void; onExit(pid: number): void }): Promise<SubscriptionUsage> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new Error('Consulta cancelada.'));
    const env = childEnv(process.env);
    delete env.ORQ_PIPE;
    delete env.ORQ_TOKEN;
    const child = spawn(process.execPath, [opts.script, '--usage-agy', opts.cwd], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) opts.onStart(child.pid);
    let output = '';
    let settled = false;
    const finish = (error?: Error, value?: SubscriptionUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      else child.kill();
    };
    const abort = () => { kill(); finish(new Error('Consulta do Antigravity cancelada.')); };
    const timer = setTimeout(() => { kill(); finish(new Error('A consulta do Antigravity demorou demais. Tente novamente.')); }, 25000);
    opts.signal.addEventListener('abort', abort, { once: true });
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64000) { kill(); finish(new Error('Resposta do Antigravity não reconhecida.')); }
    });
    child.on('error', () => finish(new Error('Não foi possível iniciar a consulta do Antigravity.')));
    child.on('close', () => {
      if (child.pid) opts.onExit(child.pid);
      if (settled) return;
      try {
        const result = JSON.parse(output);
        if (!result.ok) return finish(new Error(typeof result.error === 'string' ? result.error : 'Uso do Antigravity indisponível.'));
        finish(undefined, subscriptionUsageSchema.parse(result.usage));
      } catch { finish(new Error('Resposta do Antigravity não reconhecida.')); }
    });
  });
}
