import { describe, expect, it, vi } from 'vitest';
import { OrqError } from '@orquestra/shared';
import { HostGate } from '../src/main/host-gate';

describe('HostGate (inicialização paralela de janela e host)', () => {
  it('faz comandos aguardarem a subida assíncrona do host e os despacha assim que fica pronto', async () => {
    let resolveHost!: (value: { request: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }) => void;
    const gate = new HostGate<{ request: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>();
    gate.beginStart(new Promise((resolve) => { resolveHost = resolve; }));

    const pending = gate.requireReady();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const fakeHost = { request: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => {}) };
    resolveHost(fakeHost);
    expect(await pending).toBe(fakeHost);
  });

  it('falha com APP_UNAVAILABLE quando o host não iniciou ou retornou null', async () => {
    const gate = new HostGate<{ stop(): Promise<void> }>();
    gate.beginStart(Promise.resolve(null));
    await expect(gate.requireReady()).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
    await expect(gate.requireReady()).rejects.toBeInstanceOf(OrqError);
  });

  it('limpa pendência em rejeição não capturada e permite nova subida em seguida', async () => {
    const gate = new HostGate<{ stop(): Promise<void> }>();
    let rejectStart!: (reason?: unknown) => void;
    gate.beginStart(new Promise((_, reject) => { rejectStart = reject; }));
    const waiting = gate.requireReady();
    rejectStart(new Error('boom'));
    await expect(waiting).rejects.toThrow('boom');
    await expect(gate.waitSettled()).resolves.toBeNull();
    await expect(gate.requireReady()).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });
});
