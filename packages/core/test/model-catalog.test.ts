import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MODELS, builtinModelCatalog, type ModelAgent } from '@orquestra/shared';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../src/log.js';
import {
  discoverModels,
  ModelCatalogStore,
  parseAgyModels,
  parseClaudeCatalog,
  parseCodexModelsCache,
} from '../src/model-catalog.js';

const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/model-catalog/${name}`, import.meta.url));
const readFixture = (name: string) => readFileSync(fixturePath(name), 'utf8');

function captureLogger() {
  const infos: Array<{ fields: unknown; msg: string }> = [];
  const warns: Array<{ fields: unknown; msg: string }> = [];
  const base = silentLogger();
  const wrap = (target: Logger): Logger =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === 'info') {
          return (fields: unknown, msg?: string) => {
            infos.push({ fields, msg: msg ?? '' });
          };
        }
        if (prop === 'warn' || prop === 'error') {
          return (fields: unknown, msg?: string) => {
            warns.push({ fields, msg: msg ?? '' });
          };
        }
        if (prop === 'child') {
          return (bindings: Record<string, unknown>) => wrap(obj.child(bindings));
        }
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    });
  return { log: wrap(base), infos, warns };
}

describe('parsers do catálogo de modelos', () => {
  it('parseAgyModels lê linhas id<TAB>nome, ignora avisos sem TAB e descarta ids inválidos', () => {
    const raw = `${readFixture('agy-models.txt')}\ncom espaco\tModelo Inválido\n"aspas"\tOutro Inválido\ngemini-4-carbon-medium\tRepetido\nlinha solta sem tab\n`;
    const models = parseAgyModels(raw);
    expect(models).toHaveLength(18);
    expect(models[0]).toEqual({ id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' });
    expect(models.find((m) => m.id === 'gemini-pro-orchestrator')).toEqual({ id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' });
    expect(models.some((m) => m.id.includes(' '))).toBe(false);
  });

  it('parseCodexModelsCache filtra visibility === "list", ordena por priority, extrai client_version e descarta ids inválidos', () => {
    const json = JSON.parse(readFixture('codex-models-cache.json')) as {
      client_version: string;
      models: Array<Record<string, unknown>>;
    };
    // Embaralha e injeta um slug inválido para provar ordenação e validação.
    const shuffled = {
      ...json,
      models: [
        ...json.models.slice().reverse(),
        { slug: 'slug invalido!', display_name: 'Ruim', visibility: 'list', priority: 0 },
      ],
    };
    const parsed = parseCodexModelsCache(shuffled);
    expect(parsed.cliVersion).toBe('0.167.1');
    expect(parsed.models.map((m) => m.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(parsed.models[2]).toEqual({ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' });
  });

  it('parseClaudeCatalog mantém fable/opus/sonnet/haiku no topo, lê catalog.config.models e descarta ids inválidos', () => {
    const json = JSON.parse(readFixture('claude-catalog-cc.json')) as {
      catalog: { config: { models: Array<Record<string, unknown>> } };
    };
    json.catalog.config.models.push({ id: 'id com espaco', name: 'Inválido' });
    const models = parseClaudeCatalog(json);
    expect(models.slice(0, 4)).toEqual([
      { id: 'fable', label: 'Fable (mais recente)' },
      { id: 'opus', label: 'Opus (mais recente)' },
      { id: 'sonnet', label: 'Sonnet (mais recente)' },
      { id: 'haiku', label: 'Haiku (mais recente)' },
    ]);
    expect(models[4]).toEqual({ id: 'claude-opus-5-5', label: 'Opus 5.5' });
    expect(models.some((m) => m.id === 'claude-haiku-4-5-20251001' && m.label === 'Haiku 4.5')).toBe(true);
    expect(models.some((m) => m.id.includes(' '))).toBe(false);
    // Catálogo vazio não pode fingir sucesso só com os aliases fixos.
    expect(parseClaudeCatalog({ catalog: { config: { models: [] } } })).toEqual([]);
  });
});

describe('discoverModels', () => {
  it('descobre agy via CLI, codex via models_cache.json (sem rodar codex) e claude pelo *-cc.json mais recente ignorando *-ccd.json', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'orq-codex-cat-'));
    writeFileSync(join(codexHome, 'models_cache.json'), readFixture('codex-models-cache.json'));

    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-cat-'));
    const catalogDir = join(claudeDir, 'cache', 'model-catalog');
    mkdirSync(catalogDir, { recursive: true });
    const olderCc = join(catalogDir, 'old-cc.json');
    const newerCc = join(catalogDir, 'new-cc.json');
    const newestCcd = join(catalogDir, 'tok-newest-ccd.json');
    writeFileSync(olderCc, JSON.stringify({ catalog: { config: { models: [{ id: 'claude-old-1', name: 'Old 1' }] } } }));
    writeFileSync(newerCc, readFixture('claude-catalog-cc.json'));
    writeFileSync(newestCcd, JSON.stringify({ catalog: { config: { models: [{ id: 'claude-ccd-only', name: 'CCD Only' }] } } }));
    const baseSec = Math.floor(Date.now() / 1000);
    utimesSync(olderCc, baseSec - 30, baseSec - 30);
    utimesSync(newerCc, baseSec - 20, baseSec - 20);
    utimesSync(newestCcd, baseSec - 5, baseSec - 5);

    const cliCalls: Array<[string, string[]]> = [];
    const deps = {
      codexHome,
      claudeDir,
      now: () => 1_795_000_000_000,
      resolveExecutable: (name: string) => ({ file: `C:/fake/${name}.exe`, argsPrefix: [] }),
      execCli: async (file: string, args: string[]) => {
        cliCalls.push([file, args]);
        if (file.endsWith('agy.exe') && args[0] === 'models') return readFixture('agy-models.txt');
        if (file.endsWith('agy.exe') && args[0] === '--version') return '1.5.10\r\n';
        if (file.endsWith('claude.exe') && args[0] === '--version') return '2.1.327 (Claude Code)\r\n';
        throw new Error(`Chamada inesperada: ${file} ${args.join(' ')}`);
      },
    };

    const agy = await discoverModels('agy', deps);
    expect(agy).toMatchObject({ agent: 'agy', source: 'cli', cliVersion: '1.5.10', fetchedAt: new Date(1_795_000_000_000).toISOString() });
    expect(agy.models).toHaveLength(18);

    const codex = await discoverModels('codex', deps);
    expect(codex).toMatchObject({ agent: 'codex', source: 'cli', cliVersion: '0.167.1' });
    expect(codex.models).toHaveLength(8);
    expect(cliCalls.some(([file]) => file.includes('codex'))).toBe(false);

    const claude = await discoverModels('claude', deps);
    expect(claude).toMatchObject({ agent: 'claude', source: 'cli', cliVersion: '2.1.327' });
    expect(claude.models.some((m) => m.id === 'claude-ccd-only')).toBe(false);
    expect(claude.models.some((m) => m.id === 'claude-old-1')).toBe(false);
    expect(claude.models[4]).toEqual({ id: 'claude-opus-5-5', label: 'Opus 5.5' });
  });

  it('lista vazia ou erro retorna falha (rejeita), nunca lista vazia', async () => {
    await expect(
      discoverModels('agy', {
        resolveExecutable: () => ({ file: 'C:/fake/agy.exe', argsPrefix: [] }),
        execCli: async (_f, args) => (args[0] === '--version' ? '1.5.10' : 'Fetching available models...\n'),
      }),
    ).rejects.toThrow();

    const emptyCodex = mkdtempSync(join(tmpdir(), 'orq-codex-empty-'));
    writeFileSync(join(emptyCodex, 'models_cache.json'), JSON.stringify({ client_version: '0.167.1', models: [{ slug: 'x', display_name: 'X', visibility: 'hide', priority: 1 }] }));
    await expect(discoverModels('codex', { codexHome: emptyCodex })).rejects.toThrow();
  });

  it('em timeout, encerra o PID filho criado e falha com erro em pt-BR', async () => {
    let spawnedPid = 0;
    await expect(
      discoverModels('agy', {
        timeoutMs: 150,
        resolveExecutable: () => ({
          file: process.execPath,
          argsPrefix: ['-e', 'setInterval(() => {}, 1000)'],
        }),
        onSpawnPid: (pid) => {
          spawnedPid = pid;
        },
      }),
    ).rejects.toThrow(/tempo|demorou/i);
    expect(spawnedPid).toBeGreaterThan(0);
    // Dá um instante para o taskkill /PID <pid> /T /F finalizar o processo.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(spawnedPid, 0)).toThrow();
  });
});

describe('ModelCatalogStore', () => {
  it('cai no builtin sem cache ou com arquivo de cache inválido', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-cat-store-'));
    const { log, warns } = captureLogger();
    const emptyStore = new ModelCatalogStore({ dataDir, log });
    expect(emptyStore.get()).toEqual(builtinModelCatalog());

    writeFileSync(join(dataDir, 'model-catalog.json'), '{"claude": {"agent":"claude","models":[]}}');
    const invalidStore = new ModelCatalogStore({ dataDir, log });
    expect(invalidStore.get()).toEqual(builtinModelCatalog());
    expect(warns.length).toBeGreaterThan(0);
  });

  it('refresh grava só os agentes que deram certo, registra no log e falha posterior não apaga o cache existente', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-cat-refresh-'));
    const { log, infos, warns } = captureLogger();
    let claudeShouldFail = false;

    const store = new ModelCatalogStore({
      dataDir,
      log,
      deps: {
        discover: async (agent) => {
          if (agent === 'claude') {
            if (claudeShouldFail) throw new Error('claude fora do ar');
            return {
              agent: 'claude',
              source: 'cli',
              cliVersion: '2.1.400',
              fetchedAt: '2026-11-17T20:00:00.000Z',
              models: [{ id: 'opus', label: 'Opus (mais recente)' }, { id: 'claude-opus-6', label: 'Opus 6' }],
            };
          }
          throw new Error(`${agent} não instalado`);
        },
      },
    });

    const first = await store.refresh();
    expect(first.claude.source).toBe('cli');
    expect(first.claude.cliVersion).toBe('2.1.400');
    expect(first.claude.models).toHaveLength(2);
    expect(first.agy.source).toBe('builtin');
    expect(first.codex.source).toBe('builtin');
    expect(first.agy.models).toEqual(AGENT_MODELS.agy);

    // Só o claude entrou no arquivo em disco.
    const saved = JSON.parse(readFileSync(join(dataDir, 'model-catalog.json'), 'utf8'));
    expect(Object.keys(saved)).toEqual(['claude']);
    expect(infos).toContainEqual(
      expect.objectContaining({
        fields: { agent: 'claude', source: 'cli', cliVersion: '2.1.400', count: 2 },
      }),
    );
    expect(warns.length).toBeGreaterThanOrEqual(2);

    // Agora o claude falha: o cache anterior do claude permanece intacto!
    claudeShouldFail = true;
    await expect(store.refresh('claude')).rejects.toThrow(/claude/i);
    expect(store.get().claude).toEqual(first.claude);

    // Recarregando do disco em nova instância também preserva o claude em cache e builtin nos demais.
    const reloaded = new ModelCatalogStore({ dataDir, log: silentLogger() });
    expect(reloaded.get().claude).toEqual(first.claude);
    expect(reloaded.get().codex.source).toBe('builtin');
  });

  it('gatilho de refresh: falta de cache, idade > 24 h, versão da CLI mudada e mtime do catálogo do claude', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-cat-stale-'));
    let clock = Date.parse('2026-11-17T12:00:00.000Z');
    const versions: Record<ModelAgent, string | null> = {
      claude: '2.1.327',
      agy: '1.5.10',
      codex: '0.167.1',
    };
    let claudeMtimeMs: number | null = clock - 5_000;
    const discovered: ModelAgent[] = [];

    const store = new ModelCatalogStore({
      dataDir,
      log: silentLogger(),
      deps: {
        now: () => clock,
        probeVersion: async (agent) => versions[agent],
        probeClaudeCatalogMtime: () => claudeMtimeMs,
        discover: async (agent) => {
          discovered.push(agent);
          return {
            agent,
            source: 'cli',
            cliVersion: versions[agent],
            fetchedAt: new Date(clock).toISOString(),
            models: [{ id: `${agent}-m1`, label: `${agent} M1` }],
          };
        },
      },
    });

    // 1. Sem cache: atualiza os três.
    await store.refreshIfNeeded();
    expect(discovered.sort()).toEqual(['agy', 'claude', 'codex']);
    discovered.length = 0;

    // 2. Cache recente (1 h) e mesma versão/mtime: não atualiza nenhum.
    clock += 60 * 60 * 1000;
    await store.refreshIfNeeded();
    expect(discovered).toEqual([]);

    // 3. Versão do agy mudou: atualiza só o agy.
    versions.agy = '1.6.0';
    await store.refreshIfNeeded();
    expect(discovered).toEqual(['agy']);
    discovered.length = 0;

    // 4. mtime do catálogo do claude avançou além do fetchedAt: atualiza só o claude.
    claudeMtimeMs = clock + 1_000;
    clock += 2_000;
    await store.refreshIfNeeded();
    expect(discovered).toEqual(['claude']);
    discovered.length = 0;

    // 5. Passaram mais de 24 h: atualiza os cujos caches venceram.
    clock += 25 * 60 * 60 * 1000;
    await store.refreshIfNeeded();
    expect(discovered.sort()).toEqual(['agy', 'claude', 'codex']);
  });
});
