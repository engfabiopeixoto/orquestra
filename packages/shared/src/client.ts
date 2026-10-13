import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { userInfo } from 'node:os';
import { OrqError } from './errors.js';
import { parseResult, PROTOCOL_VERSION, responseSchema, type MethodName, type Params, type Result } from './protocol.js';

export type ClientOptions = { pipePath: string; token: string; signal?: AbortSignal };

export function defaultPipePath(): string {
  return `\\\\.\\pipe\\orquestra-${userInfo().username}`;
}

export function call<M extends MethodName>(opts: ClientOptions, method: M, params: Params<M>): Promise<Result<M>> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new OrqError('APP_UNAVAILABLE', 'Consulta cancelada.'));
    const id = randomUUID();
    const socket = net.connect(opts.pipePath);
    let buffer = '';
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', abort);
      socket.destroy();
      finish();
    };
    const abort = () => settle(() => reject(new OrqError('APP_UNAVAILABLE', 'Consulta cancelada.')));
    opts.signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ v: PROTOCOL_VERSION, id, token: opts.token, method, params }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = responseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.ok) {
          const result = parseResult(method, response.result);
          settle(() => resolve(result));
        } else {
          settle(() => reject(new OrqError(response.error.code, response.error.message)));
        }
      } catch {
        settle(() => reject(new OrqError('INTERNAL', 'Resposta inválida do Orquestra. Atualize o orq e o app juntos.')));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(new OrqError('APP_UNAVAILABLE', `O Orquestra não está respondendo (${error.code ?? error.message}). Abra o app e tente de novo.`)),
      );
    });
    socket.on('close', () => {
      settle(() => reject(new OrqError('APP_UNAVAILABLE', 'O Orquestra fechou a conexão antes de responder. Tente de novo.')));
    });
  });
}
