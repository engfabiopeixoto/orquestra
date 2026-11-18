import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  agentModelCatalogSchema,
  builtinModelCatalog,
  modelNameSchema,
  OrqError,
  type AgentModelCatalog,
  type ModelAgent,
  type ModelCatalog,
  type ModelOption,
} from '@orquestra/shared';
import { z } from 'zod';
import { childEnv } from './env.js';
import type { Logger } from './log.js';
import { resolveExecutable, type ResolvedExecutable } from './resolve-exe.js';

export const MODEL_CATALOG_FILE = 'model-catalog.json';
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLI_TIMEOUT_MS = 30_000;
const MODEL_AGENTS: readonly ModelAgent[] = ['claude', 'agy', 'codex'];

const CLAUDE_TOP_ALIASES: readonly ModelOption[] = [
  { id: 'fable', label: 'Fable (mais recente)' },
  { id: 'opus', label: 'Opus (mais recente)' },
  { id: 'sonnet', label: 'Sonnet (mais recente)' },
  { id: 'haiku', label: 'Haiku (mais recente)' },
];

function pushValidOption(out: ModelOption[], seen: Set<string>, rawId: unknown, rawLabel: unknown): void {
  if (typeof rawId !== 'string' || typeof rawLabel !== 'string') return;
  const parsed = modelNameSchema.safeParse(rawId);
  const label = rawLabel.trim();
  if (!parsed.success || !label || seen.has(parsed.data)) return;
  seen.add(parsed.data);
  out.push({ id: parsed.data, label });
}

/** Lê a saída de `agy models`: linhas "id<TAB>nome", ignorando cabeçalhos/avisos sem TAB e ids inválidos. */
export function parseAgyModels(text: string): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    pushValidOption(out, seen, line.slice(0, tab), line.slice(tab + 1));
  }
  return out;
}

const codexCacheRawSchema = z.object({
  client_version: z.string().optional().nullable(),
  models: z.array(z.record(z.unknown())),
});

/** Lê `~/.codex/models_cache.json`: só `visibility === "list"`, ordenado por `priority`, com `client_version`. */
export function parseCodexModelsCache(input: unknown): { cliVersion: string | null; models: ModelOption[] } {
  const json = typeof input === 'string' ? JSON.parse(input) : input;
  const parsed = codexCacheRawSchema.parse(json);
  const visible = parsed.models
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.visibility === 'list')
    .sort((a, b) => {
      const pa = typeof a.entry.priority === 'number' && Number.isFinite(a.entry.priority) ? a.entry.priority : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.entry.priority === 'number' && Number.isFinite(b.entry.priority) ? b.entry.priority : Number.MAX_SAFE_INTEGER;
      return pa !== pb ? pa - pb : a.index - b.index;
    });
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const { entry } of visible) {
    pushValidOption(models, seen, entry.slug, entry.display_name);
  }
  const rawVersion = typeof parsed.client_version === 'string' ? parsed.client_version.trim() : '';
  return { cliVersion: rawVersion || null, models };
}

const claudeCatalogRawSchema = z.object({
  catalog: z.object({
    config: z.object({
      models: z.array(z.record(z.unknown())),
    }),
  }),
});

/** Lê `*-cc.json` do Claude Code: aliases fixos sempre no topo, seguidos de `catalog.config.models[]`. */
export function parseClaudeCatalog(input: unknown): ModelOption[] {
  const json = typeof input === 'string' ? JSON.parse(input) : input;
  const parsed = claudeCatalogRawSchema.parse(json);
  const discovered: ModelOption[] = [];
  const seen = new Set<string>(CLAUDE_TOP_ALIASES.map((alias) => alias.id));
  for (const item of parsed.catalog.config.models) {
    pushValidOption(discovered, seen, item.id, item.name);
  }
  if (discovered.length === 0) return [];
  return [...CLAUDE_TOP_ALIASES.map((alias) => ({ ...alias })), ...discovered];
}

export function parseCliVersion(stdout: string): string | null {
  const firstLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const semver = /\bv?(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z._-]+)?)\b/.exec(firstLine);
  if (semver?.[1]) return semver[1];
  return /^[A-Za-z0-9._-]+$/.test(firstLine) ? firstLine : null;
}

export type ExecCliOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onSpawnPid?: (pid: number) => void;
  onExitPid?: (pid: number) => void;
};

function killChildPid(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* já encerrado */
    }
  }
}

export function runCliCommand(file: string, args: string[], opts: ExecCliOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? CLI_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      return reject(new OrqError('APP_UNAVAILABLE', 'Consulta à CLI cancelada.'));
    }
    const env = childEnv(opts.env ?? process.env);
    delete env.ORQ_PIPE;
    delete env.ORQ_TOKEN;

    let settled = false;
    let timedOut = false;
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout) => {
        if (child.pid) opts.onExitPid?.(child.pid);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (timedOut) {
          return reject(new OrqError('APP_UNAVAILABLE', 'A consulta à CLI demorou mais de 30 segundos (tempo esgotado).'));
        }
        if (error) {
          return reject(new OrqError('APP_UNAVAILABLE', `Falha ao executar a CLI: ${error.message}`));
        }
        resolve(stdout);
      },
    );
    child.stdin?.end();
    const pid = child.pid;
    if (pid) opts.onSpawnPid?.(pid);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) killChildPid(pid);
      reject(new OrqError('APP_UNAVAILABLE', 'Consulta à CLI cancelada.'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) killChildPid(pid);
      reject(new OrqError('APP_UNAVAILABLE', 'A consulta à CLI demorou mais de 30 segundos (tempo esgotado).'));
    }, timeoutMs);

    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type DiscoverModelsDeps = {
  codexHome?: string;
  claudeDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  resolveExecutable?: (name: string) => ResolvedExecutable;
  execCli?: (file: string, args: string[], opts: ExecCliOptions) => Promise<string>;
  onSpawnPid?: (pid: number) => void;
  onExitPid?: (pid: number) => void;
};

function resolveCodexHome(deps: DiscoverModelsDeps): string {
  const env = deps.env ?? process.env;
  return deps.codexHome ?? env.CODEX_HOME ?? join(homedir(), '.codex');
}

function resolveClaudeDir(deps: DiscoverModelsDeps): string {
  const env = deps.env ?? process.env;
  return deps.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function findLatestClaudeCatalogFile(claudeDir: string): { path: string; mtimeMs: number } | null {
  const dir = join(claudeDir, 'cache', 'model-catalog');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    // Só *-cc.json (ignora *-ccd.json e outros arquivos).
    if (!name.endsWith('-cc.json')) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
    } catch {
      /* arquivo removido durante a varredura */
    }
  }
  return best;
}

async function invokeCli(name: ModelAgent, cliArgs: string[], deps: DiscoverModelsDeps): Promise<string> {
  const resolve = deps.resolveExecutable ?? ((target: string) => resolveExecutable(target, { env: deps.env }));
  const exec = deps.execCli ?? runCliCommand;
  const executable = resolve(name);
  return exec(executable.file, [...executable.argsPrefix, ...cliArgs], {
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
    env: deps.env,
    onSpawnPid: deps.onSpawnPid,
    onExitPid: deps.onExitPid,
  });
}

/** Verifica de forma barata a versão atual da CLI (sem consultar rede). */
export async function probeCliVersion(agent: ModelAgent, deps: DiscoverModelsDeps = {}): Promise<string | null> {
  try {
    if (agent === 'codex') {
      const cacheFile = join(resolveCodexHome(deps), 'models_cache.json');
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) as { client_version?: unknown };
      return typeof raw.client_version === 'string' && raw.client_version.trim() ? raw.client_version.trim() : null;
    }
    const stdout = await invokeCli(agent, ['--version'], deps);
    return parseCliVersion(stdout);
  } catch {
    return null;
  }
}

export async function discoverModels(agent: ModelAgent, deps: DiscoverModelsDeps = {}): Promise<AgentModelCatalog> {
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString();

  if (agent === 'agy') {
    const [modelsText, versionText] = await Promise.all([
      invokeCli('agy', ['models'], deps),
      invokeCli('agy', ['--version'], deps).catch(() => ''),
    ]);
    const models = parseAgyModels(modelsText);
    if (models.length === 0) {
      throw new OrqError('APP_UNAVAILABLE', 'Não foi possível obter a lista de modelos do agy (lista vazia).');
    }
    return {
      agent: 'agy',
      source: 'cli',
      cliVersion: parseCliVersion(versionText),
      fetchedAt,
      models,
    };
  }

  if (agent === 'codex') {
    const cacheFile = join(resolveCodexHome(deps), 'models_cache.json');
    let raw: string;
    try {
      raw = readFileSync(cacheFile, 'utf8');
    } catch {
      throw new OrqError('APP_UNAVAILABLE', 'Não foi possível ler o catálogo de modelos do Codex (~/.codex/models_cache.json). Abra o Codex uma vez e tente novamente.');
    }
    let parsed: { cliVersion: string | null; models: ModelOption[] };
    try {
      parsed = parseCodexModelsCache(raw);
    } catch {
      throw new OrqError('APP_UNAVAILABLE', 'O arquivo de modelos do Codex está inválido.');
    }
    if (parsed.models.length === 0) {
      throw new OrqError('APP_UNAVAILABLE', 'Nenhum modelo visível encontrado no catálogo do Codex.');
    }
    return {
      agent: 'codex',
      source: 'cli',
      cliVersion: parsed.cliVersion,
      fetchedAt,
      models: parsed.models,
    };
  }

  // claude
  const latest = findLatestClaudeCatalogFile(resolveClaudeDir(deps));
  if (!latest) {
    throw new OrqError('APP_UNAVAILABLE', 'Catálogo de modelos do Claude Code não encontrado. Abra o Claude Code uma vez e tente novamente.');
  }
  let models: ModelOption[];
  try {
    models = parseClaudeCatalog(readFileSync(latest.path, 'utf8'));
  } catch {
    throw new OrqError('APP_UNAVAILABLE', 'O catálogo de modelos do Claude Code está inválido.');
  }
  if (models.length === 0) {
    throw new OrqError('APP_UNAVAILABLE', 'Nenhum modelo válido encontrado no catálogo do Claude Code.');
  }
  const versionText = await invokeCli('claude', ['--version'], deps);
  return {
    agent: 'claude',
    source: 'cli',
    cliVersion: parseCliVersion(versionText),
    fetchedAt,
    models,
  };
}

const modelCatalogCacheFileSchema = z
  .object({
    claude: agentModelCatalogSchema.refine((entry) => entry.agent === 'claude').optional(),
    agy: agentModelCatalogSchema.refine((entry) => entry.agent === 'agy').optional(),
    codex: agentModelCatalogSchema.refine((entry) => entry.agent === 'codex').optional(),
  })
  .strict();

export type ModelCatalogStoreDeps = DiscoverModelsDeps & {
  discover?: (agent: ModelAgent, deps: DiscoverModelsDeps) => Promise<AgentModelCatalog>;
  probeVersion?: (agent: ModelAgent, deps: DiscoverModelsDeps) => Promise<string | null>;
  probeClaudeCatalogMtime?: (claudeDir: string) => number | null;
  maxAgeMs?: number;
};

export class ModelCatalogStore {
  private readonly file: string;
  private readonly log: Logger;
  private readonly deps: ModelCatalogStoreDeps;
  private readonly abortController = new AbortController();
  private cached: Partial<Record<ModelAgent, AgentModelCatalog>> = {};
  private readonly inFlight = new Map<ModelAgent, Promise<{ ok: true } | { ok: false; error: Error }>>();
  private allInFlight: Promise<ModelCatalog> | null = null;
  private readonly listeners = new Set<(catalog: ModelCatalog) => void>();
  private closed = false;

  constructor(opts: { dataDir: string; file?: string; log: Logger; deps?: ModelCatalogStoreDeps }) {
    this.file = opts.file ?? join(opts.dataDir, MODEL_CATALOG_FILE);
    this.log = opts.log;
    this.deps = opts.deps ?? {};
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = modelCatalogCacheFileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      const loaded: Partial<Record<ModelAgent, AgentModelCatalog>> = {};
      for (const agent of MODEL_AGENTS) {
        const entry = parsed[agent];
        if (entry && entry.source === 'cli') loaded[agent] = entry;
      }
      this.cached = loaded;
    } catch (error) {
      this.log.warn({ err: error, file: this.file }, 'cache do catálogo de modelos inválido; ignorado');
      this.cached = {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.cached, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch (error) {
      this.log.warn({ err: error, file: this.file }, 'não foi possível gravar o cache do catálogo de modelos');
    }
  }

  private notify(): void {
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: (catalog: ModelCatalog) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(): ModelCatalog {
    const builtin = builtinModelCatalog();
    return {
      claude: this.cached.claude ? { ...this.cached.claude, models: this.cached.claude.models.map((m) => ({ ...m })) } : builtin.claude,
      agy: this.cached.agy ? { ...this.cached.agy, models: this.cached.agy.models.map((m) => ({ ...m })) } : builtin.agy,
      codex: this.cached.codex ? { ...this.cached.codex, models: this.cached.codex.models.map((m) => ({ ...m })) } : builtin.codex,
    };
  }

  private discoverDeps(): DiscoverModelsDeps {
    return {
      ...this.deps,
      signal: this.deps.signal ?? this.abortController.signal,
    };
  }

  private refreshOne(agent: ModelAgent, emitOnSuccess: boolean): Promise<{ ok: true } | { ok: false; error: Error }> {
    const existing = this.inFlight.get(agent);
    if (existing) {
      return emitOnSuccess
        ? existing.then((res) => {
            if (res.ok) this.notify();
            return res;
          })
        : existing;
    }

    const discover = this.deps.discover ?? discoverModels;
    const task = (async (): Promise<{ ok: true } | { ok: false; error: Error }> => {
      try {
        const discovered = agentModelCatalogSchema.parse(await discover(agent, this.discoverDeps()));
        if (discovered.agent !== agent || discovered.source !== 'cli') {
          throw new Error(`Catálogo inválido retornado para ${agent}.`);
        }
        if (this.closed) return { ok: false, error: new OrqError('APP_UNAVAILABLE', 'Catálogo encerrado.') };
        this.cached[agent] = discovered;
        this.persist();
        this.log.info(
          { agent, source: discovered.source, cliVersion: discovered.cliVersion, count: discovered.models.length },
          'catálogo de modelos atualizado',
        );
        if (emitOnSuccess) this.notify();
        return { ok: true };
      } catch (failure) {
        const err = failure instanceof Error ? failure : new Error(String(failure));
        if (!this.closed && !this.abortController.signal.aborted) {
          this.log.warn({ err, agent }, 'falha ao atualizar o catálogo de modelos');
        }
        return { ok: false, error: err };
      } finally {
        this.inFlight.delete(agent);
      }
    })();

    this.inFlight.set(agent, task);
    return task;
  }

  async refresh(agent?: ModelAgent): Promise<ModelCatalog> {
    if (agent) {
      const outcome = await this.refreshOne(agent, true);
      if (!outcome.ok) {
        if (outcome.error instanceof OrqError) throw outcome.error;
        throw new OrqError('APP_UNAVAILABLE', `Não foi possível atualizar a lista de modelos do ${agent}: ${outcome.error.message}`);
      }
      return this.get();
    }

    if (this.allInFlight) return this.allInFlight;
    const batch = (async () => {
      try {
        const outcomes = await Promise.all(MODEL_AGENTS.map((item) => this.refreshOne(item, false)));
        if (outcomes.some((outcome) => outcome.ok)) this.notify();
        return this.get();
      } finally {
        this.allInFlight = null;
      }
    })();
    this.allInFlight = batch;
    return batch;
  }

  private async needsRefresh(agent: ModelAgent): Promise<boolean> {
    const entry = this.cached[agent];
    if (!entry || entry.source !== 'cli' || !entry.fetchedAt) return true;
    const fetchedMs = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(fetchedMs)) return true;
    const now = (this.deps.now ?? Date.now)();
    const maxAge = this.deps.maxAgeMs ?? MODEL_CATALOG_MAX_AGE_MS;
    if (now - fetchedMs > maxAge) return true;

    const probe = this.deps.probeVersion ?? probeCliVersion;
    const currentVersion = await probe(agent, this.discoverDeps());
    if (currentVersion !== null && currentVersion !== entry.cliVersion) return true;

    if (agent === 'claude') {
      const probeMtime =
        this.deps.probeClaudeCatalogMtime ??
        ((dir: string) => findLatestClaudeCatalogFile(dir)?.mtimeMs ?? null);
      const mtimeMs = probeMtime(resolveClaudeDir(this.deps));
      if (mtimeMs !== null && Math.floor(mtimeMs) > fetchedMs) return true;
    }

    return false;
  }

  async refreshIfNeeded(): Promise<ModelCatalog> {
    if (this.closed) return this.get();
    const checks = await Promise.all(
      MODEL_AGENTS.map(async (agent) => ({ agent, stale: await this.needsRefresh(agent) })),
    );
    if (this.closed) return this.get();
    const staleAgents = checks.filter((item) => item.stale).map((item) => item.agent);
    if (staleAgents.length === 0) return this.get();
    const outcomes = await Promise.all(staleAgents.map((agent) => this.refreshOne(agent, false)));
    if (!this.closed && outcomes.some((outcome) => outcome.ok)) this.notify();
    return this.get();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
    this.listeners.clear();
    await Promise.allSettled([...this.inFlight.values(), ...(this.allInFlight ? [this.allInFlight] : [])]);
  }
}
