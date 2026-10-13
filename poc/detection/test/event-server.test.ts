import { spawn } from 'node:child_process';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newPipePath, startEventServer, type EventServer } from '../src/event-server.js';
import { RELAY_PATH } from '../src/types.js';
import type { HookEnvelope } from '../src/types.js';

function runRelay(args: string[], stdin: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [RELAY_PATH, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe('relay + servidor do pipe', () => {
  let server: EventServer | undefined;
  afterEach(async () => server?.close());

  it('entrega o payload com acentos ao servidor', async () => {
    server = await startEventServer({ pipePath: newPipePath(), token: 'tok-1' });
    const received = new Promise<HookEnvelope>((resolve) => server!.onEnvelope(resolve));
    const result = await runRelay(['claude', 'Stop'], JSON.stringify({ last_assistant_message: 'ação ✅' }), {
      ORQ_POC_PIPE: server.pipePath,
      ORQ_POC_TOKEN: 'tok-1',
    });
    const envelope = await received;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(envelope.agent).toBe('claude');
    expect(envelope.event).toBe('Stop');
    expect(envelope.payload).toEqual({ last_assistant_message: 'ação ✅' });
  });

  it('recusa token errado', async () => {
    server = await startEventServer({ pipePath: newPipePath(), token: 'tok-certo' });
    const rejected = new Promise<string>((resolve) => server!.onRejected(resolve));
    await runRelay(['claude', 'Stop'], '{}', { ORQ_POC_PIPE: server.pipePath, ORQ_POC_TOKEN: 'tok-errado' });
    expect(await rejected).toMatch(/token/);
  });

  it('sai com 0 e em silêncio quando não há pipe no ambiente', async () => {
    const result = await runRelay(['claude', 'Stop'], '{}', { ORQ_POC_PIPE: '', ORQ_POC_TOKEN: '' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('sai com 0 quando o pipe não existe', async () => {
    const result = await runRelay(['claude', 'Stop'], '{}', {
      ORQ_POC_PIPE: '\\\\.\\pipe\\orq-poc-inexistente',
      ORQ_POC_TOKEN: 'x',
    });
    expect(result.code).toBe(0);
  });

  it('close não espera conexões que ficaram abertas', async () => {
    const local = await startEventServer({ pipePath: newPipePath(), token: 't' });
    const socket = net.connect(local.pipePath);
    await new Promise((resolve) => socket.once('connect', resolve));
    const closed = await Promise.race([local.close().then(() => 'fechou'), new Promise((r) => setTimeout(() => r('travou'), 1000))]);
    socket.destroy();
    expect(closed).toBe('fechou');
  });

  it('imprime {} no stdout quando o agente é o agy', async () => {
    server = await startEventServer({ pipePath: newPipePath(), token: 't' });
    const result = await runRelay(['agy', 'Stop'], '{}', { ORQ_POC_PIPE: server.pipePath, ORQ_POC_TOKEN: 't' });
    expect(result.stdout).toBe('{}');
  });

  it('preserva stdin que não é JSON', async () => {
    server = await startEventServer({ pipePath: newPipePath(), token: 't' });
    const received = new Promise<HookEnvelope>((resolve) => server!.onEnvelope(resolve));
    await runRelay(['agy', 'Stop'], 'texto solto', { ORQ_POC_PIPE: server.pipePath, ORQ_POC_TOKEN: 't' });
    expect((await received).payload).toEqual({ unparsed: 'texto solto' });
  });
});
