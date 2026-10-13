import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createAppLogger(dataDir: string): { log: Logger; logDir: string } {
  const logDir = join(dataDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const transport = pino.transport({
    target: 'pino-roll',
    options: { file: join(logDir, 'orquestra-app'), extension: '.log', frequency: 'daily', size: '10m', mkdir: true, limit: { count: 14 } },
  });
  return { log: pino({ level: process.env.ORQ_LOG_LEVEL ?? 'info', base: { app: 'orquestra', component: 'main' } }, transport), logDir };
}
