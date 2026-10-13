import net from 'node:net';
import { isMethodName, OrqError, parseParams, PROTOCOL_VERSION, requestSchema, type MethodName, type Response } from '@orquestra/shared';
import type { Logger } from './log.js';

export type Caller = { session: string };
/** `signal` aborta quando o cliente desconecta (o orq pode ser morto pelo limite da ferramenta do agente). */
export type Dispatch = (method: MethodName, params: unknown, caller: Caller, signal: AbortSignal) => Promise<unknown>;

export type PipeServerOptions = {
  pipePath: string;
  authenticate: (token: string) => Caller | undefined;
  dispatch: Dispatch;
  log: Logger;
};

export type PipeServer = { close(): Promise<void> };

export function startPipeServer(opts: PipeServerOptions): Promise<PipeServer> {
  const sockets = new Set<net.Socket>();

  async function respond(line: string, signal: AbortSignal): Promise<Response> {
    let id = '?';
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new OrqError('USAGE', 'Mensagem inválida no pipe: não é JSON.');
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) throw new OrqError('USAGE', 'Mensagem inválida no pipe: formato de requisição errado.');
      const request = parsed.data;
      id = request.id;
      if (request.v !== PROTOCOL_VERSION) {
        throw new OrqError(
          'VERSION_MISMATCH',
          `O orq usa o protocolo ${request.v} e o Orquestra usa o ${PROTOCOL_VERSION}. Atualize os dois juntos.`,
        );
      }
      const caller = opts.authenticate(request.token);
      if (!caller) throw new OrqError('INVALID_TOKEN', 'Token inválido. Rode o orq de dentro de um terminal do Orquestra.');
      if (!isMethodName(request.method)) throw new OrqError('USAGE', `Método desconhecido: ${request.method}.`);
      const params = parseParams(request.method, request.params);
      const result = await opts.dispatch(request.method, params, caller, signal);
      return { id, ok: true, result };
    } catch (error) {
      if (error instanceof OrqError) return { id, ok: false, error: { code: error.code, message: error.message } };
      opts.log.error({ err: error, id }, 'erro interno ao atender o pipe');
      return { id, ok: false, error: { code: 'INTERNAL', message: 'Erro interno do Orquestra. Veja o log em %APPDATA%\\Orquestra\\logs.' } };
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const disconnected = new AbortController();
    socket.on('close', () => {
      sockets.delete(socket);
      disconnected.abort();
    });
    socket.on('error', (error) => opts.log.debug({ err: error }, 'conexão do pipe com erro'));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        void respond(line, disconnected.signal).then((response) => {
          // O orq pode ter sido morto pelo limite da ferramenta do agente: o pedido segue sem resposta direta.
          if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(response) + '\n');
        });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.pipePath, () => {
      server.off('error', reject);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
