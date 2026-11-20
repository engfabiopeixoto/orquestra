import { describe, expect, it, vi } from 'vitest';
import { HostGate } from '../src/main/host-gate';
import { createPortalLifecycle } from '../src/main/portal/portal-lifecycle';

describe('createPortalLifecycle (corrida create/destroy durante subida do host)', () => {
  it('pula portal.register quando o portal foi destruído antes de o host ficar pronto', async () => {
    const request = vi.fn(async () => ({}));
    const gate = new HostGate<{ request: typeof request }>();
    let resolveHost!: (value: { request: typeof request }) => void;
    gate.beginStart(new Promise((resolve) => { resolveHost = resolve; }));

    let alive = true;
    const lifecycle = createPortalLifecycle(gate, (workspaceId, id) => alive && workspaceId === 'w1' && id === 'p1');
    const registering = lifecycle.register('w1', 'p1');
    alive = false;
    resolveHost({ request });

    await registering;
    expect(request).not.toHaveBeenCalled();
  });

  it('desregistra no host quando o portal é destruído enquanto portal.register está em voo', async () => {
    let alive = true;
    let resolveRegister!: (value: Record<string, never>) => void;
    const calls: Array<[string, unknown]> = [];
    const request = vi.fn((method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'portal.register') return new Promise<Record<string, never>>((resolve) => { resolveRegister = resolve; });
      return Promise.resolve({});
    });
    const gate = new HostGate<{ request: typeof request }>();
    gate.beginStart(Promise.resolve({ request }));
    await gate.waitSettled();

    const lifecycle = createPortalLifecycle(gate, () => alive);
    const registering = lifecycle.register('w1', 'p1');
    await Promise.resolve();
    alive = false;
    resolveRegister({});
    await registering;

    expect(calls).toEqual([
      ['portal.register', { id: 'p1', title: 'Navegador' }],
      ['portal.unregister', { id: 'p1' }],
    ]);
  });
});
