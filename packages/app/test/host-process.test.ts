import { fileURLToPath } from 'node:url';
import type { HostEvent } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { HostProcess } from '../src/main/host-process';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const fakeHost = fixture('fake-host.mjs');
let host: HostProcess | undefined;
afterEach(async () => {
  await host?.stop(500);
  host = undefined;
});

function create(env: Record<string, string> = {}) {
  host = new HostProcess({ nodePath: process.execPath, script: fakeHost, env: { ...process.env, ...env }, startTimeoutMs: 3000 });
  return host;
}

describe('HostProcess', () => {
  it('inicia, pede e recebe resultado tipado', async () => {
    const h = create();
    await h.start();
    await expect(h.request('project.open', { dir: 'C:/p' })).resolves.toEqual({
      dir: 'C:/p',
      name: 'p',
      terminals: [],
      notes: [],
      edges: [],
      layout: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('erro do núcleo vira OrqError com o código', async () => {
    const h = create();
    await h.start();
    await expect(h.request('edge.connect', { a: 'A', b: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'X não existe.' });
  });

  it('responde às confirmações do núcleo e repassa eventos', async () => {
    const h = create();
    const events: HostEvent[] = [];
    h.onEvent((event) => events.push(event));
    h.setConfirmHandler(async (message) => message === 'pode?');
    await h.start();
    await h.request('project.close', {});
    await expect.poll(() => events).toContainEqual({ type: 'notice', level: 'info', message: 'confirmado:true' });
  });

  it('queda do núcleo rejeita os pedidos em curso e avisa', async () => {
    const h = create();
    const exits: Array<number | null> = [];
    h.onUnexpectedExit((code) => exits.push(code));
    await h.start();
    await expect(h.request('terminal.remove', { name: 'A' })).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
    await expect.poll(() => exits).toEqual([3]);
  });

  it('encerra à força o núcleo que não responde ao pedido de saída', async () => {
    const h = create({ FAKE_HOST_HANG: '1' });
    await h.start();
    const startedAt = Date.now();
    await h.stop(500);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    await expect(h.request('project.open', { dir: 'C:/p' })).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });

  it('núcleo que sai antes de ficar pronto falha na hora, sem esperar o prazo', async () => {
    host = new HostProcess({ nodePath: process.execPath, script: fakeHost, env: { ...process.env, FAKE_HOST_EXIT_EARLY: '1' }, startTimeoutMs: 20_000 });
    const startedAt = Date.now();
    await expect(host.start()).rejects.toMatchObject({ code: 'APP_UNAVAILABLE', message: expect.stringMatching(/parou ao iniciar/) });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('núcleo que não fica pronto falha no prazo', async () => {
    const h = create({ FAKE_HOST_SILENT: '1' });
    await expect(h.start()).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });

  it('núcleo que sai com pipe ocupado vira mensagem específica', async () => {
    const host = new HostProcess({ nodePath: process.execPath, script: fixture('host-pipe-busy.mjs'), env: process.env, onLog: () => {} });
    await expect(host.start()).rejects.toThrow(/já está usando o pipe do Orquestra/);
  });
});
