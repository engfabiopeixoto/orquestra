import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { OrqError, parseHostParams, type HostToMain, type MainToHost, type WorkspaceInfo, type ProjectSnapshot, type TerminalInfo } from '@orquestra/shared';
import { startHostBridge, type HostBridge, type HostBridgeOptions, type UsageState } from './bridge.js';
import { FlowWorkerPool } from './flow-workers.js';

const MAX_WORKSPACES = 3;
const registrySchema = z.object({ version: z.literal(1), selectedId: z.string().nullable(), workspaces: z.array(z.object({ id: z.string(), dir: z.string(), name: z.string() })).max(MAX_WORKSPACES) });
type Entry = { info: WorkspaceInfo; bridge?: HostBridge; tail: Promise<unknown>; terminals: Map<string, TerminalInfo>; sequence: number; inFlight: Set<Promise<unknown>> };
type Command = Extract<MainToHost, { kind: 'command' }>;

/** One process, isolated runtimes. UI selection never changes a runtime's pipe or token. */
export async function startWorkspaceManager(opts: HostBridgeOptions): Promise<HostBridge> {
  const entries = new Map<string, Entry>();
  const pids = new Map<string, number[]>();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const confirms = new Map<string, HostBridge>();
  const portalRoutes = new Map<string, HostBridge>();
  const usageState: UsageState = { cache: new Map(), pending: new Map(), failures: new Map() };
  const registryFile = join(opts.dataDir, 'workspaces.json');
  let selectedId: string | null = null;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let stopping = false;
  const flowWorkers = new FlowWorkerPool({ onPids: (values) => recordPids('flow-workers', values) });

  try {
    const saved = registrySchema.parse(JSON.parse(readFileSync(registryFile, 'utf8')));
    selectedId = saved.selectedId;
    for (const item of saved.workspaces) entries.set(item.id, { info: { ...item, status: 'paused', terminalCount: 0, busy: 0, waiting: 0 }, tail: Promise.resolve(), terminals: new Map(), sequence: 0, inFlight: new Set() });
    if (!selectedId || !entries.has(selectedId)) selectedId = entries.keys().next().value ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') opts.log.warn({ err: error }, 'registro de workspaces inválido; ignorado');
  }

  function persist(): void {
    try {
      mkdirSync(dirname(registryFile), { recursive: true });
      const data = { version: 1, selectedId, workspaces: [...entries.values()].map(({ info }) => ({ id: info.id, dir: info.dir, name: info.name })) };
      writeFileSync(`${registryFile}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${registryFile}.tmp`, registryFile);
    } catch (error) { opts.log.warn({ err: error }, 'não foi possível salvar as abas'); }
  }

  function recordPids(id: string, values: number[]): void {
    pids.set(id, values);
    if (!opts.agentPidFile) return;
    try { writeFileSync(opts.agentPidFile, JSON.stringify([...new Set([...pids.values()].flat())])); }
    catch (error) { opts.log.warn({ err: error }, 'não foi possível registrar os agentes'); }
  }

  function receive(id: string, message: HostToMain): void {
    if (message.kind === 'portal-call') {
      const bridge = entries.get(id)?.bridge;
      if (bridge) { portalRoutes.set(message.id, bridge); opts.send({ ...message, workspaceId: id }); }
      return;
    }
    if (message.kind === 'portal-cancel') { portalRoutes.delete(message.id); opts.send(message); return; }
    if (message.kind === 'response' || message.kind === 'response-error') {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.kind === 'response-error') call.reject(new OrqError(message.error.code, message.error.message));
        else call.resolve(message.result);
        return;
      }
    }
    if (message.kind === 'confirm') {
      const bridge = id === 'global' ? globalBridge : entries.get(id)?.bridge;
      if (bridge) confirms.set(message.id, bridge);
    }
    if (message.kind === 'event') {
      const event = message.event;
      const entry = entries.get(id);
      if (entry) {
        entry.sequence++;
        if (event.type === 'terminal.state') {
          const terminal = entry.terminals.get(event.name);
          if (terminal) entry.terminals.set(event.name, { ...terminal, state: event.state, queued: event.queued });
        } else if (event.type === 'terminal.added') entry.terminals.set(event.info.name, event.info);
        else if (event.type === 'terminal.removed') entry.terminals.delete(event.name);
      }
      // Background output stays in the core's bounded screen; no IPC/xterm work for hidden canvases.
      if (event.type === 'terminal.output' && id !== selectedId) return;
      opts.send({ ...message, event: { ...event, ...(id === 'global' ? {} : { workspaceId: id, sequence: entry?.sequence }) } });
      return;
    }
    opts.send(message);
  }

  const globalBridge = await startHostBridge({ ...opts, flowWorkers, agentPidFile: undefined, usageState, onPids: (values) => recordPids('global', values), send: (message) => receive('global', message) });
  recordPids('global', []);

  function call(bridge: HostBridge, method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void bridge.handle({ kind: 'command', id, method, params }).catch((error) => { pending.delete(id); reject(error); });
    });
  }

  function enqueue<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const task = entry.tail.then(work);
    entry.tail = task.catch(() => {});
    return task;
  }

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = lifecycle.then(work);
    lifecycle = task.catch(() => {});
    return task;
  }

  function list() {
    return { selectedId, workspaces: [...entries.values()].map((entry) => {
      const terminals = [...entry.terminals.values()];
      return { ...entry.info, terminalCount: terminals.length, busy: terminals.filter((terminal) => terminal.state === 'busy' || terminal.queued > 0).length, waiting: terminals.filter((terminal) => terminal.state === 'waiting').length };
    }) };
  }

  function canonical(dir: string): string {
    try {
      const path = realpathSync.native(dir);
      if (!statSync(path).isDirectory()) throw new Error('not a directory');
      return path;
    } catch { throw new OrqError('USAGE', `A pasta ${dir} não está disponível. Escolha outra pasta de projeto.`); }
  }

  const identity = (dir: string) => process.platform === 'win32' ? dir.toLowerCase() : dir;

  async function activate(entry: Entry): Promise<ProjectSnapshot> {
    if (!entry.bridge) {
      entry.info.status = 'opening';
      const suffix = createHash('sha256').update(entry.info.id).digest('hex').slice(0, 16);
      try {
        entry.bridge = await startHostBridge({ ...opts, flowWorkers, pipePath: `${opts.pipePath}-${suffix}`, agentPidFile: undefined, usageState, eventSequence: () => entry.sequence, onPids: (values) => recordPids(entry.info.id, values), send: (message) => receive(entry.info.id, message) });
      } catch (error) { entry.info.status = 'paused'; throw error; }
    }
    try {
      const snapshot = await enqueue(entry, () => call(entry.bridge!, 'project.open', { dir: entry.info.dir })) as ProjectSnapshot;
      entry.terminals = new Map(snapshot.terminals.map((terminal) => [terminal.name, terminal]));
      entry.info.status = 'open';
      selectedId = entry.info.id;
      persist();
      return { ...snapshot, workspaceId: entry.info.id };
    } catch (error) {
      await entry.bridge.close(); entry.bridge = undefined; entry.info.status = 'paused';
      throw error;
    }
  }

  async function execute(message: Command): Promise<unknown> {
    if (stopping) throw new OrqError('APP_UNAVAILABLE', 'O Orquestra está encerrando.');
    if (message.method === 'workspace.list') { parseHostParams('workspace.list', message.params); return list(); }
    if (message.method === 'project.open') {
      const { dir } = parseHostParams('project.open', message.params);
      return exclusive(async () => {
        const path = canonical(dir);
        const existing = [...entries.values()].find((entry) => identity(entry.info.dir) === identity(path));
        if (existing) return activate(existing);
        if (entries.size >= MAX_WORKSPACES) throw new OrqError('USAGE', 'Limite de 3 workspaces. Feche uma aba antes de abrir outro projeto.');
        const id = randomUUID();
        const entry: Entry = { info: { id, dir: path, name: basename(path), status: 'opening', terminalCount: 0, busy: 0, waiting: 0 }, tail: Promise.resolve(), terminals: new Map(), sequence: 0, inFlight: new Set() };
        entries.set(id, entry);
        try { return await activate(entry); }
        catch (error) { entries.delete(id); pids.delete(id); throw error; }
      });
    }
    if (message.method === 'workspace.activate') {
      const { id } = parseHostParams('workspace.activate', message.params);
      return exclusive(async () => {
        const entry = entries.get(id);
        if (!entry) throw new OrqError('NOT_FOUND', 'Workspace não está aberto.');
        canonical(entry.info.dir);
        return activate(entry);
      });
    }
    const id = message.workspaceId;
    if (message.method === 'project.close') {
      parseHostParams('project.close', message.params);
      return exclusive(async () => {
        const entry = id ? entries.get(id) : undefined;
        if (!entry) throw new OrqError('NOT_FOUND', 'Workspace não está aberto.');
        entry.info.status = 'closing';
        await entry.bridge?.cancelWork?.();
        try {
          if (entry.bridge) await enqueue(entry, async () => { await Promise.allSettled([...entry.inFlight]); await call(entry.bridge!, 'project.close', {}); await entry.bridge!.close(); });
        } catch (error) { entry.info.status = entry.bridge ? 'open' : 'paused'; throw error; }
        entries.delete(entry.info.id); pids.delete(entry.info.id);
        if (selectedId === entry.info.id) selectedId = entries.keys().next().value ?? null;
        persist();
        return {};
      });
    }
    if (/^(settings\.|recent\.)/.test(message.method)) return call(globalBridge, message.method, message.params);
    const entry = id ? entries.get(id) : undefined;
    if (/^usage\./.test(message.method)) return call(entry?.bridge ?? globalBridge, message.method, message.params);
    if (!id && /^persona\./.test(message.method)) return call(globalBridge, message.method, message.params);
    if (!entry?.bridge || entry.info.status !== 'open') throw new OrqError('APP_UNAVAILABLE', 'Ative o workspace antes de usar seus elementos.');
    // Capture this runtime now; never resolve through mutable UI selection after an await.
    const work = async () => {
      const result = await call(entry.bridge!, message.method, message.params);
      if (/^terminal\.(create|update|restart|unload|presentation|rename)$/.test(message.method)) {
        const info = result as TerminalInfo;
        const oldName = (message.params as { name?: string }).name;
        if (oldName && oldName !== info.name) entry.terminals.delete(oldName);
        entry.terminals.set(info.name, info);
      } else if (message.method === 'terminal.duplicate') {
        const info = (result as { info: TerminalInfo }).info; entry.terminals.set(info.name, info);
      }
      return result;
    };
    if (/^(terminal\.(create|update|remove|restart|unload|duplicate|rename|presentation)|note\.|edge\.|layout\.|group\.|portal\.)/.test(message.method)) return enqueue(entry, work);
    // File reads/screen settling must not hold up keyboard input. Close drains these calls.
    const task = work();
    entry.inFlight.add(task);
    try { return await task; } finally { entry.inFlight.delete(task); }
  }

  return {
    async handle(message) {
      if (message.kind === 'portal-reply') { const bridge = portalRoutes.get(message.id); portalRoutes.delete(message.id); if (bridge) await bridge.handle(message); return; }
      if (message.kind === 'confirm-reply') {
        const bridge = confirms.get(message.id); confirms.delete(message.id);
        if (bridge) await bridge.handle(message);
        return;
      }
      try { opts.send({ kind: 'response', id: message.id, ok: true, result: await execute(message) }); }
      catch (error) {
        if (!(error instanceof OrqError)) opts.log.error({ err: error, method: message.method }, 'erro no gerenciador de workspaces');
        const failure = error instanceof OrqError ? error : new OrqError('INTERNAL', 'Erro interno do Orquestra. Veja o log.');
        opts.send({ kind: 'response-error', id: message.id, error: { code: failure.code, message: failure.message } });
      }
    },
    dispatchForTest: (method, params, caller) => {
      const entry = selectedId ? entries.get(selectedId) : undefined;
      return (entry?.bridge ?? globalBridge).dispatchForTest(method, params, caller);
    },
    async close() {
      stopping = true;
      // Cancel confirmation dialogs before waiting for commands that may be awaiting them.
      await Promise.all([...confirms].map(([id, bridge]) => bridge.handle({ kind: 'confirm-reply', id, approved: false })));
      confirms.clear();
      await lifecycle;
      await Promise.all([...entries.values()].map((entry) => entry.bridge?.cancelWork?.()));
      await Promise.all([...entries.values()].map(async (entry) => { await entry.tail; await Promise.allSettled([...entry.inFlight]); await entry.bridge?.close(); }));
      await globalBridge.close();
      await flowWorkers.close();
    },
  };
}
