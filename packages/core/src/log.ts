import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';

export type { Logger };
export type LoggerHandle = { log: Logger; close(): Promise<void> };

export function createLogger(opts: { dir: string; name: string; level?: string }): LoggerHandle {
  mkdirSync(opts.dir, { recursive: true });
  const transport = pino.transport({
    target: 'pino-roll',
    options: { file: join(opts.dir, opts.name), extension: '.log', frequency: 'daily', size: '10m', mkdir: true, limit: { count: 14 } },
  });
  const log = pino({ level: opts.level ?? process.env.ORQ_LOG_LEVEL ?? 'info', base: { app: 'orquestra' } }, transport);
  return {
    log,
    close: () =>
      new Promise<void>((resolve) => {
        transport.once('close', () => resolve());
        transport.end();
      }),
  };
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
