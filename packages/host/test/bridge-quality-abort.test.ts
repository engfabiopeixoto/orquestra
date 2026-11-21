import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostToMain } from '@orquestra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../core/src/log.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';

let onMeasureStarted: (() => void) | undefined;
let settleMeasure: (() => void) | undefined;

vi.mock('../src/quality-worker.js', () => ({
  measureQualityIsolated: () =>
    new Promise<never>((_resolve, reject) => {
      settleMeasure = () => reject(new Error('medição encerrada pelo teste'));
      onMeasureStarted?.();
    }),
}));

import { startHostBridge, type HostBridge } from '../src/bridge.js';

let bridge: HostBridge | undefined;

afterEach(async () => {
  settleMeasure?.();
  settleMeasure = undefined;
  onMeasureStarted = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe('abortBackground e encerramento da qualidade', () => {
  it('abortBackground seguido de close aguarda a medição pendente assentar', async () => {
    const sent: HostToMain[] = [];
    bridge = await startHostBridge({
      send: (message: HostToMain) => sent.push(message),
      adapters: { shell: createFakeAdapter(), agy: createFakeAdapter() },
      recentFile: join(mkdtempSync(join(tmpdir(), 'orq-recent-')), 'recent.json'),
      settingsFile: join(mkdtempSync(join(tmpdir(), 'orq-settings-')), 'settings.json'),
      personasFile: join(mkdtempSync(join(tmpdir(), 'orq-personas-')), 'personas.json'),
      saveDelayMs: 20,
      cliScript: 'C:/orq/bin/orq.mjs',
      pipePath: `\\\\.\\pipe\\orq-bridge-${randomBytes(4).toString('hex')}`,
      dataDir: mkdtempSync(join(tmpdir(), 'orq-bridge-')),
      log: silentLogger(),
      ptyHost: new FakePtyHost(),
      readyQuietMs: 20,
      agyHooksFile: join(mkdtempSync(join(tmpdir(), 'orq-agyhook-')), 'hooks.json'),
      outputIntervalMs: 5,
      agentPidFile: join(mkdtempSync(join(tmpdir(), 'orq-pids-')), 'agentes-ativos.json'),
      backgroundJobPollMs: 30,
      modelCatalogDeps: {
        probeVersion: async () => null,
        probeClaudeCatalogMtime: () => null,
        discover: async (agent: string) => {
          throw new Error(`${agent} desativado nos testes`);
        },
      },
    });

    const dir = mkdtempSync(join(tmpdir(), 'orq-quality-abort-'));
    await bridge.handle({ kind: 'command', id: 'open-1', method: 'project.open', params: { dir } });

    const started = new Promise<void>((resolve) => {
      onMeasureStarted = resolve;
    });
    const measurePromise = bridge.handle({
      kind: 'command',
      id: 'measure-1',
      method: 'quality.measure',
      params: {},
    });

    await started;
    await Promise.resolve();

    bridge.abortBackground?.();

    let closed = false;
    const closePromise = bridge.close().then(() => {
      closed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);

    settleMeasure?.();
    await Promise.all([closePromise, measurePromise]);
    expect(closed).toBe(true);
  });
});
