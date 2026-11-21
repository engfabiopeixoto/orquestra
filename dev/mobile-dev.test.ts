import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runMobileDev, type MobileDevDeps } from './mobile-dev.js';

function createFakeDeps(overrides: Partial<MobileDevDeps> = {}) {
  const events: string[] = [];
  const emitter = new EventEmitter();
  const stdin = new EventEmitter() as NodeJS.ReadStream & { isTTY?: boolean };
  stdin.isTTY = true;

  let closed = false;
  let dataDirCreated = '';
  const bridge = {
    handle: vi.fn(async () => {}),
    dispatchForTest: vi.fn(),
    close: vi.fn(async () => {
      closed = true;
      events.push('bridge.close');
    }),
  };

  const gateway = {
    enable: vi.fn(async () => {
      events.push('gateway.enable');
      return {
        enabled: true,
        port: 47821,
        localUrl: 'http://127.0.0.1:47821',
        devicesCount: 0,
        tailscale: {
          state: 'serving' as const,
          dnsName: 'pc.tailnet.ts.net',
          url: 'https://pc.tailnet.ts.net:8444',
          error: null,
          tailscaleIp: '100.64.0.1',
        },
      };
    }),
    wrapBridge: vi.fn((_inner: unknown) => bridge),
    onHostMessage: vi.fn(),
    pair: vi.fn(() => ({
      token: 'pair-1',
      url: 'https://pc.tailnet.ts.net:8444/?pair=pair-1',
      expiresAt: '2026-11-18T03:10:00Z',
    })),
    status: vi.fn(() => ({
      enabled: true,
      port: 47821,
      localUrl: 'http://127.0.0.1:47821',
      devicesCount: 0,
      tailscale: {
        state: 'serving' as const,
        dnsName: 'pc.tailnet.ts.net',
        url: 'https://pc.tailnet.ts.net:8444',
        error: null,
        tailscaleIp: '100.64.0.1',
      },
    })),
    close: vi.fn(async () => {
      closed = true;
      events.push('gateway.close');
    }),
  };

  const exitCodes: number[] = [];
  const registeredSignals: string[] = [];
  const signalTarget = {
    on: (sig: string, fn: () => void) => {
      registeredSignals.push(sig);
      events.push(`signal.on:${sig}`);
      emitter.on(sig, fn);
    },
    off: (sig: string, fn: () => void) => {
      emitter.off(sig, fn);
    },
  };

  const deps: MobileDevDeps = {
    argv: ['node', 'mobile-dev.ts', '--tailscale'],
    buildCli: async () => 'fake-cli.js',
    buildMobile: () => {},
    installCli: () => ({ script: 'fake-cli.js', binDir: 'fake-bin' }),
    createGateway: (opts) => {
      dataDirCreated = opts.dataDir;
      return gateway as unknown as ReturnType<NonNullable<MobileDevDeps['createGateway']>>;
    },
    startWorkspaceManager: async () => ({
      handle: async () => {},
      dispatchForTest: async () => ({}),
      close: async () => {},
    }),
    sleep: async () => {},
    signalTarget,
    stdin,
    exit: (code) => {
      exitCodes.push(code);
      events.push(`exit:${code}`);
    },
    ...overrides,
  };

  return {
    deps,
    events,
    emitter,
    bridge,
    gateway,
    exitCodes,
    registeredSignals,
    isClosed: () => closed,
    getDataDir: () => dataDirCreated,
  };
}

describe('mobile:dev ciclo de vida e limpeza de tailscale', () => {
  it('registra SIGINT, SIGTERM, SIGHUP e SIGBREAK antes de gateway.enable(true) e fecha o bridge se falhar na semeadura', async () => {
    const ctx = createFakeDeps();
    ctx.bridge.handle.mockImplementation(async () => {
      throw new Error('falha simulada na semeadura');
    });

    await runMobileDev(ctx.deps);

    const enableIdx = ctx.events.indexOf('gateway.enable');
    expect(enableIdx).toBeGreaterThan(-1);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      expect(ctx.registeredSignals).toContain(sig);
      const sigIdx = ctx.events.indexOf(`signal.on:${sig}`);
      expect(sigIdx).toBeGreaterThan(-1);
      expect(sigIdx).toBeLessThan(enableIdx);
    }

    expect(ctx.bridge.close).toHaveBeenCalledTimes(1);
    expect(ctx.exitCodes).toEqual([1]);
    expect(existsSync(ctx.getDataDir())).toBe(false);
  });

  it('encerra o bridge (removendo regra 8444) se Ctrl+C/SIGINT chegar durante a espera inicial antes do fim do startup', async () => {
    let releaseSleep!: () => void;
    const ctx = createFakeDeps({
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    // Responde ao project.open / terminal.create imediatamente para chegar no sleep(2000)
    let onHostMessageRef: ((msg: any) => void) | undefined;
    const origWrap = ctx.gateway.wrapBridge;
    ctx.gateway.wrapBridge = vi.fn((inner) => {
      const b = origWrap(inner);
      b.handle = vi.fn(async (msg: any) => {
        if (msg.kind === 'command') {
          queueMicrotask(() => {
            ctx.gateway.onHostMessage({
              kind: 'response',
              id: msg.id,
              ok: true,
              result: { workspaceId: 'w-dev' },
            });
          });
        }
      });
      return b;
    });
    void onHostMessageRef;

    const runPromise = runMobileDev(ctx.deps);
    // Prazo folgado: sob a suíte inteira, 1 s (padrão do waitFor) não basta.
    await vi.waitFor(() => expect(releaseSleep).toBeTypeOf('function'), { timeout: 10_000 });

    ctx.emitter.emit('SIGINT');
    await vi.waitFor(() => expect(ctx.exitCodes).toEqual([0]), { timeout: 10_000 });
    expect(ctx.bridge.close).toHaveBeenCalledTimes(1);

    releaseSleep();
    await runPromise;
    expect(ctx.bridge.close).toHaveBeenCalledTimes(1);
  });
});
