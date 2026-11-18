import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinModelCatalog, type HostToMain, type ModelAgent } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelCatalogStoreDeps } from '@orquestra/core';
import { silentLogger } from '../../core/src/log.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';
import { waitFor } from '../../core/test/helpers/wait.js';
import { startHostBridge, type HostBridge } from '../src/bridge.js';
import { startWorkspaceManager } from '../src/workspace-manager.js';

const bridges: HostBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
});

async function setupBridge(opts: { dataDir?: string; modelCatalogDeps?: ModelCatalogStoreDeps; agySettingsFile?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'orq-bridge-cat-'));
  const sent: HostToMain[] = [];
  const ptyHost = new FakePtyHost();
  const agyFake = createFakeAdapter();
  const bridge = await startHostBridge({
    send: (message) => sent.push(message),
    adapters: {
      shell: createFakeAdapter(),
      agy: { ...agyFake, kind: 'agy' },
    },
    cliScript: 'C:/orq/bin/orq.mjs',
    pipePath: `\\\\.\\pipe\\orq-bcat-${randomBytes(4).toString('hex')}`,
    dataDir,
    recentFile: join(dataDir, 'recent.json'),
    settingsFile: join(dataDir, 'settings.json'),
    personasFile: join(dataDir, 'personas.json'),
    agyHooksFile: join(dataDir, 'agy-hooks.json'),
    agySettingsFile: opts.agySettingsFile,
    log: silentLogger(),
    ptyHost,
    readyQuietMs: 20,
    outputIntervalMs: 5,
    modelCatalogDeps: opts.modelCatalogDeps,
  });
  bridges.push(bridge);

  const command = async (method: string, params: unknown = {}) => {
    const id = randomUUID();
    await bridge.handle({ kind: 'command', id, method, params });
    const response = sent.find(
      (m): m is Extract<HostToMain, { kind: 'response' | 'response-error' }> =>
        (m.kind === 'response' || m.kind === 'response-error') && m.id === id,
    );
    if (!response) throw new Error(`Sem resposta para ${method}`);
    if (response.kind === 'response-error') {
      throw Object.assign(new Error(response.error.message), { code: response.error.code });
    }
    return response.result as any;
  };

  return { bridge, sent, command, dataDir, ptyHost };
}

describe('catálogo de modelos no bridge e workspace-manager', () => {
  it('carrega o cache na partida, atualiza em segundo plano os desatualizados e emite evento models.catalog', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-bridge-startup-'));
    const now = Date.parse('2026-11-17T18:00:00.000Z');
    writeFileSync(
      join(dataDir, 'model-catalog.json'),
      JSON.stringify({
        codex: {
          agent: 'codex',
          source: 'cli',
          cliVersion: '0.167.1',
          fetchedAt: new Date(now - 60_000).toISOString(),
          models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
        },
        claude: {
          agent: 'claude',
          source: 'cli',
          cliVersion: '2.1.300',
          fetchedAt: new Date(now - 60_000).toISOString(),
          models: [{ id: 'opus', label: 'Opus (mais recente)' }],
        },
      }),
    );

    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshed: ModelAgent[] = [];

    const { command, sent } = await setupBridge({
      dataDir,
      modelCatalogDeps: {
        now: () => now,
        probeVersion: async (agent) => ({ codex: '0.167.1', claude: '2.1.327', agy: '1.5.10' })[agent],
        probeClaudeCatalogMtime: () => now - 120_000,
        discover: async (agent) => {
          refreshed.push(agent);
          await gate;
          return {
            agent,
            source: 'cli',
            cliVersion: agent === 'claude' ? '2.1.327' : '1.5.10',
            fetchedAt: new Date(now).toISOString(),
            models: [{ id: `${agent}-novo`, label: `${agent} Novo` }],
          };
        },
      },
    });

    const initial = await command('models.catalog');
    expect(initial.codex.source).toBe('cli');
    expect(initial.claude.cliVersion).toBe('2.1.300');
    expect(initial.agy).toEqual(builtinModelCatalog().agy);

    await waitFor(() => refreshed.length === 2);
    expect([...refreshed].sort()).toEqual(['agy', 'claude']);

    releaseRefresh();
    await waitFor(() => sent.some((m) => m.kind === 'event' && m.event.type === 'models.catalog'));
    const catalogEvent = sent.find((m) => m.kind === 'event' && m.event.type === 'models.catalog');
    expect(catalogEvent).toMatchObject({
      kind: 'event',
      event: {
        type: 'models.catalog',
        catalog: {
          claude: { cliVersion: '2.1.327', models: [{ id: 'claude-novo', label: 'claude Novo' }] },
          agy: { cliVersion: '1.5.10', models: [{ id: 'agy-novo', label: 'agy Novo' }] },
          codex: { cliVersion: '0.167.1' },
        },
      },
    });
  });

  it('dois models.refresh simultâneos reaproveitam a mesma promessa (uma única descoberta) e erro de agente retorna response-error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-bridge-concurrent-'));
    const now = Date.now();
    writeFileSync(
      join(dataDir, 'model-catalog.json'),
      JSON.stringify({
        claude: { agent: 'claude', source: 'cli', cliVersion: '2.1.327', fetchedAt: new Date(now).toISOString(), models: [{ id: 'opus', label: 'Opus' }] },
        agy: { agent: 'agy', source: 'cli', cliVersion: '1.5.10', fetchedAt: new Date(now).toISOString(), models: [{ id: 'gemini-4-carbon-medium', label: 'Carbon' }] },
        codex: { agent: 'codex', source: 'cli', cliVersion: '0.167.1', fetchedAt: new Date(now).toISOString(), models: [{ id: 'gpt-6.1-sol', label: 'Sol' }] },
      }),
    );

    let discoverCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { bridge, sent } = await setupBridge({
      dataDir,
      modelCatalogDeps: {
        now: () => now,
        probeVersion: async (agent) => ({ claude: '2.1.327', agy: '1.5.10', codex: '0.167.1' })[agent],
        probeClaudeCatalogMtime: () => now - 1000,
        discover: async (agent) => {
          if (agent === 'claude') throw new Error('catálogo ausente');
          discoverCount++;
          await gate;
          return {
            agent,
            source: 'cli',
            cliVersion: '0.170.0',
            fetchedAt: new Date(now + 5000).toISOString(),
            models: [{ id: 'gpt-7-sol', label: 'GPT-7-Sol' }],
          };
        },
      },
    });

    const p1 = bridge.handle({ kind: 'command', id: 'r1', method: 'models.refresh', params: { agent: 'codex' } });
    const p2 = bridge.handle({ kind: 'command', id: 'r2', method: 'models.refresh', params: { agent: 'codex' } });
    await waitFor(() => discoverCount === 1);
    release();
    await Promise.all([p1, p2]);

    expect(discoverCount).toBe(1);
    const r1 = sent.find((m) => m.kind === 'response' && m.id === 'r1');
    const r2 = sent.find((m) => m.kind === 'response' && m.id === 'r2');
    expect(r1).toMatchObject({ kind: 'response', ok: true, result: { codex: { cliVersion: '0.170.0' } } });
    expect(r2).toMatchObject({ kind: 'response', ok: true, result: { codex: { cliVersion: '0.170.0' } } });

    await bridge.handle({ kind: 'command', id: 'r-err', method: 'models.refresh', params: { agent: 'claude' } });
    const rErr = sent.find((m) => m.kind === 'response-error' && m.id === 'r-err');
    expect(rErr).toMatchObject({ kind: 'response-error', error: { code: 'APP_UNAVAILABLE' } });
  });

  it('injeta a lista do agy do catálogo atual no orquestra (startupModel reconhece modelo novo) e funciona via workspace-manager sem projeto aberto', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-wm-cat-'));
    const agySettingsFile = join(dataDir, 'agy-settings.json');
    writeFileSync(agySettingsFile, JSON.stringify({ model: 'Orchestrator (Quantum)' }));

    const sent: HostToMain[] = [];
    const manager = await startWorkspaceManager({
      send: (m) => sent.push(m),
      adapters: { shell: createFakeAdapter(), agy: { ...createFakeAdapter(), kind: 'agy' } },
      cliScript: 'C:/orq/bin/orq.mjs',
      pipePath: `\\\\.\\pipe\\orq-wmcat-${randomUUID()}`,
      dataDir,
      recentFile: join(dataDir, 'recent.json'),
      settingsFile: join(dataDir, 'settings.json'),
      personasFile: join(dataDir, 'personas.json'),
      agyHooksFile: join(dataDir, 'agy-hooks.json'),
      agySettingsFile,
      log: silentLogger(),
      ptyHost: new FakePtyHost(),
      readyQuietMs: 10,
      outputIntervalMs: 5,
      modelCatalogDeps: {
        discover: async (agent) => {
          if (agent !== 'agy') throw new Error('indisponível');
          return {
            agent: 'agy',
            source: 'cli',
            cliVersion: '1.6.0',
            fetchedAt: '2026-11-17T21:30:00.000Z',
            models: [{ id: 'gemini-pro-orchestrator-quantum', label: 'Orchestrator (Quantum)' }],
          };
        },
      },
    });
    bridges.push(manager);

    const callManager = async (method: string, params: unknown = {}, workspaceId?: string) => {
      const id = randomUUID();
      await manager.handle({ kind: 'command', id, method, params, workspaceId });
      const res = sent.find((m) => (m.kind === 'response' || m.kind === 'response-error') && m.id === id);
      if (res?.kind !== 'response') throw new Error(JSON.stringify(res));
      return res.result as any;
    };

    const refreshed = await callManager('models.refresh', { agent: 'agy' });
    expect(refreshed.agy.models).toEqual([{ id: 'gemini-pro-orchestrator-quantum', label: 'Orchestrator (Quantum)' }]);

    const projectDir = mkdtempSync(join(tmpdir(), 'orq-wm-proj-'));
    const snap = await callManager('project.open', { dir: projectDir });
    const creating = manager.handle({
      kind: 'command',
      id: 't1',
      method: 'terminal.create',
      params: { name: 'A1', agent: 'agy' },
      workspaceId: snap.workspaceId,
    });
    await waitFor(() => sent.some((m) => m.kind === 'confirm'));
    const confirm = sent.find((m) => m.kind === 'confirm')!;
    if (confirm.kind === 'confirm') await manager.handle({ kind: 'confirm-reply', id: confirm.id, approved: true });
    await creating;
    const t1 = sent.find((m) => m.kind === 'response' && m.id === 't1') as Extract<HostToMain, { kind: 'response' }>;
    expect((t1.result as any).model).toEqual({
      chosen: null,
      effective: 'gemini-pro-orchestrator-quantum',
      status: 'unset',
    });
  });
});
