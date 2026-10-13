import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { call, OrqError } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { startPipeServer, type Dispatch } from '../src/pipe-server.js';

const pipe = () => `\\\\.\\pipe\\orq-test-${randomBytes(4).toString('hex')}`;
let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => closeServer?.());

async function serve(dispatch: Dispatch) {
  const pipePath = pipe();
  const server = await startPipeServer({
    pipePath,
    authenticate: (token) => (token === 'tok-A' ? { session: 'A' } : undefined),
    dispatch,
    log: silentLogger(),
  });
  closeServer = server.close;
  return pipePath;
}

describe('pipe', () => {
  it('ida e volta tipada com o chamador identificado pelo token', async () => {
    const pipePath = await serve(async (method, _params, caller) => ({ name: caller.session, agent: method }));
    await expect(call({ pipePath, token: 'tok-A' }, 'whoami', {})).resolves.toEqual({ name: 'A', agent: 'whoami' });
  });

  it('token inválido vira INVALID_TOKEN', async () => {
    const pipePath = await serve(async () => ({}));
    await expect(call({ pipePath, token: 'x' }, 'peers', {})).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('parâmetros inválidos viram USAGE sem chamar o handler', async () => {
    let called = false;
    const pipePath = await serve(async () => {
      called = true;
      return {};
    });
    await expect(call({ pipePath, token: 'tok-A' }, 'read', { target: '' })).rejects.toMatchObject({ code: 'USAGE' });
    expect(called).toBe(false);
  });

  it('OrqError do handler chega ao cliente com o mesmo código', async () => {
    const pipePath = await serve(async () => {
      throw new OrqError('NOT_CONNECTED', 'B não está conectado a você.');
    });
    await expect(call({ pipePath, token: 'tok-A' }, 'peers', {})).rejects.toMatchObject({ code: 'NOT_CONNECTED', message: 'B não está conectado a você.' });
  });

  it('erro inesperado vira INTERNAL sem vazar detalhes', async () => {
    const pipePath = await serve(async () => {
      throw new Error('segredo interno');
    });
    const error = await call({ pipePath, token: 'tok-A' }, 'peers', {}).catch((e: OrqError) => e);
    expect(error).toMatchObject({ code: 'INTERNAL' });
    expect((error as OrqError).message).not.toContain('segredo');
  });

  it('versão diferente vira VERSION_MISMATCH', async () => {
    const pipePath = await serve(async () => ({}));
    const response = await rawRequest(pipePath, { v: 99, id: '1', token: 'tok-A', method: 'peers', params: {} });
    expect(response).toMatchObject({ ok: false, error: { code: 'VERSION_MISMATCH' } });
  });

  it('transporta 200 KB com Unicode sem cortar', async () => {
    const big = 'ação ✅ 🚀 '.repeat(20_000);
    const pipePath = await serve(async () => ({ text: big }));
    const result = await call({ pipePath, token: 'tok-A' }, 'read', { target: 'B' });
    expect(result.text).toBe(big);
  });

  it('cliente que desconecta no meio não derruba o servidor', async () => {
    let release: (() => void) | undefined;
    const pipePath = await serve(async (method) => {
      if (method === 'prompt') await new Promise<void>((resolve) => (release = resolve));
      return method === 'prompt' ? { status: 'answered', askId: 'x', answer: 'tarde' } : { peers: [] };
    });
    const socket = net.connect(pipePath);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(JSON.stringify({ v: 1, id: '1', token: 'tok-A', method: 'prompt', params: { target: 'B', text: 'x', timeoutMs: 1000 } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    release?.();
    await expect(call({ pipePath, token: 'tok-A' }, 'peers', {})).resolves.toEqual({ peers: [] });
  });

  it('avisa o handler quando o cliente desconecta no meio', async () => {
    let aborted = false;
    const pipePath = await serve(async (_method, _params, _caller, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      aborted = true;
      return { peers: [] };
    });
    const socket = net.connect(pipePath);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(JSON.stringify({ v: 1, id: '1', token: 'tok-A', method: 'peers', params: {} }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(aborted).toBe(true);
  });

  it('pipe inexistente vira APP_UNAVAILABLE', async () => {
    await expect(call({ pipePath: pipe(), token: 'x' }, 'peers', {})).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });
});

function rawRequest(pipePath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.connect(pipePath, () => socket.write(JSON.stringify(body) + '\n'));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffer.split('\n')[0]!));
      }
    });
  });
}
