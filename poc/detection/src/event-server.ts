import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';
import type { HookEnvelope } from './types.js';

const wireSchema = z.object({
  token: z.string(),
  agent: z.enum(['fake', 'claude', 'codex', 'agy']),
  event: z.string(),
  payload: z.unknown(),
});

export interface EventServer {
  pipePath: string;
  onEnvelope(cb: (envelope: HookEnvelope) => void): void;
  onRejected(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

export function newPipePath(): string {
  return `\\\\.\\pipe\\orq-poc-${process.pid}-${randomBytes(4).toString('hex')}`;
}

export function startEventServer(opts: { pipePath: string; token: string }): Promise<EventServer> {
  const envelopeListeners: Array<(envelope: HookEnvelope) => void> = [];
  const rejectListeners: Array<(reason: string) => void> = [];
  const reject = (reason: string) => rejectListeners.forEach((cb) => cb(reason));

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed: z.infer<typeof wireSchema>;
        try {
          parsed = wireSchema.parse(JSON.parse(line));
        } catch (error) {
          reject(`mensagem inválida: ${String(error)}`);
          continue;
        }
        if (parsed.token !== opts.token) {
          reject('token inválido');
          continue;
        }
        const envelope: HookEnvelope = {
          agent: parsed.agent,
          event: parsed.event,
          payload: parsed.payload,
          receivedAt: Date.now(),
        };
        envelopeListeners.forEach((cb) => cb(envelope));
      }
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(opts.pipePath, () =>
      resolve({
        pipePath: opts.pipePath,
        onEnvelope: (cb) => void envelopeListeners.push(cb),
        onRejected: (cb) => void rejectListeners.push(cb),
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}
