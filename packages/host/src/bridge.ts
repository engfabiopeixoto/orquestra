import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  agyStopHookCommand,
  createOrquestra,
  ensureAgyGlobalHook,
  ModelCatalogStore,
  PersonaStore,
  RecentProjects,
  SettingsStore,
  type Note,
  type Orquestra,
  type Session,
} from '@orquestra/core';
import {
  browserMethodSchemas,
  isHostMethod,
  OrqError,
  parseHostParams,
  type BrowserHandler,
  type NoteInfo,
  type Persona,
  type ProjectSnapshot,
  type TerminalInfo,
} from '@orquestra/shared';
import { OutputBatcher } from './output-batcher.js';
import { NOTE_SIZE, placeBeside, TERMINAL_SIZE } from './placement.js';
import type {
  BridgeContext,
  BridgeMethod,
  CreateTerminalInput,
  Handlers,
  HostBridge,
  HostBridgeOptions,
  OpenProject,
} from './bridge/context.js';
import { createAppHandlers } from './bridge/app-handlers.js';
import { createGroupHandlers, createGroupHelpers } from './bridge/group-handlers.js';
import { createNoteHandlers } from './bridge/note-handlers.js';
import { createProjectController } from './bridge/project-handlers.js';
import { createQualityController } from './bridge/quality.js';
import { createRegentHandler } from './bridge/regent-handlers.js';
import { createRemovedTerminalTracker } from './bridge/removed-terminals.js';
import { createTerminalHandlers } from './bridge/terminal-handlers.js';
import { createUsageController } from './bridge/usage.js';

export type { HostBridge, HostBridgeOptions, UsageState } from './bridge/context.js';

/** Sobe a ponte do processo principal com os domínios de terminais, notas, grupos, uso e qualidade. */
export async function startHostBridge(opts: HostBridgeOptions): Promise<HostBridge> {
  let orquestra: Orquestra | undefined;
  let project: OpenProject | null = null;
  let closing = false;
  const catalogPids = new Set<number>();

  const removedTerminals = createRemovedTerminalTracker();
  const batcher = new OutputBatcher(
    (name, data) => opts.send({ kind: 'event', event: { type: 'terminal.output', name, data } }),
    opts.outputIntervalMs,
  );
  const recent = new RecentProjects({ file: opts.recentFile, log: opts.log });
  const settings = new SettingsStore({ file: opts.settingsFile, log: opts.log });
  const personaStore = new PersonaStore({ file: opts.personasFile, log: opts.log });
  const confirms = new Map<string, (approved: boolean) => void>();
  const portalCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();

  const requireProject = (): OpenProject => {
    if (!project) throw new OrqError('USAGE', 'Nenhum projeto aberto. Abra uma pasta de projeto primeiro.');
    return project;
  };
  const requireSession = (name: string): Session => {
    const session = orquestra!.session(name);
    if (!session) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
    return session;
  };
  const capture = (current: OpenProject) =>
    current.state.capture({ terminals: orquestra!.describeTerminals(), notes: orquestra!.notes.list(), connections: orquestra!.topology.edges() });
  const changed = () => project?.saver.schedule();
  const noteInfo = (note: Note): NoteInfo => ({ id: note.id, name: note.name, content: note.content, revision: note.revision, updatedBy: note.updatedBy });

  const usageController = createUsageController({ opts, getOrquestra: () => orquestra, getProject: () => project, recordPids });
  const qualityController = createQualityController({ opts, requireProject, requireSession, getProject: () => project, isClosing: () => closing, recordPids });

  function recordPids(): void {
    const sessionPids = orquestra ? orquestra.sessions().filter((s) => s.pid > 0 && s.state !== 'exited').map((s) => s.pid) : [];
    const pids = [...sessionPids, ...usageController.pids(), ...qualityController.pids(), ...catalogPids];
    opts.onPids?.(pids);
    if (!opts.agentPidFile) return;
    try { writeFileSync(opts.agentPidFile, JSON.stringify(pids)); }
    catch (error) { opts.log.warn({ err: error, file: opts.agentPidFile }, 'não foi possível gravar os PIDs dos agentes'); }
  }

  const ownsModelCatalog = !opts.modelCatalog;
  const modelCatalog = opts.modelCatalog ?? new ModelCatalogStore({
    dataDir: opts.dataDir,
    log: opts.log.child({ component: 'model-catalog' }),
    deps: {
      ...opts.modelCatalogDeps,
      claudeDir: opts.modelCatalogDeps?.claudeDir ?? opts.claudeDir,
      onSpawnPid: (pid) => { catalogPids.add(pid); opts.modelCatalogDeps?.onSpawnPid?.(pid); if (orquestra) recordPids(); },
      onExitPid: (pid) => { catalogPids.delete(pid); opts.modelCatalogDeps?.onExitPid?.(pid); if (orquestra) recordPids(); },
    },
  });
  const unsubscribeModelCatalog = ownsModelCatalog
    ? modelCatalog.subscribe((catalog) => opts.send({ kind: 'event', event: { type: 'models.catalog', catalog } }))
    : () => {};

  const info = (session: Session): TerminalInfo => {
    const descriptor = orquestra!.describeTerminals().find((t) => t.name === session.name);
    const model = orquestra!.modelOf(session.name);
    return {
      id: session.id, name: session.name, agent: session.adapter.kind, state: session.state,
      queued: orquestra!.broker.queued(session.name), cwd: session.cwd, resume: descriptor?.resume ?? true,
      args: descriptor?.args ?? [], regente: descriptor?.regente ?? false, monitor: descriptor?.monitor ?? false,
      ...(descriptor?.unloaded ? { unloaded: true } : {}), ...(model ? { model } : {}), ...project?.state.presentation(session.name),
    };
  };

  const browser: BrowserHandler = (method, params, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new OrqError('APP_UNAVAILABLE', 'Operação cancelada.'));
    const id = randomUUID();
    const finish = () => { portalCalls.delete(id); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { opts.send({ kind: 'portal-cancel', id }); finish(); reject(new OrqError('APP_UNAVAILABLE', 'Operação cancelada.')); };
    const timer = setTimeout(() => { opts.send({ kind: 'portal-cancel', id }); finish(); reject(new OrqError('APP_UNAVAILABLE', 'O navegador não respondeu em 20 segundos.')); }, 20000);
    portalCalls.set(id, { resolve: (value) => { finish(); try { resolve(browserMethodSchemas[method].result.parse(value) as never); } catch { reject(new OrqError('INTERNAL', 'Resposta inválida do navegador.')); } }, reject: (error) => { finish(); reject(error); } });
    signal.addEventListener('abort', abort, { once: true });
    opts.send({ kind: 'portal-call', id, method, params });
  });

  const requestConfirm = (message: string) => new Promise<boolean>((resolve) => {
    const id = randomUUID();
    confirms.set(id, resolve);
    opts.send({ kind: 'confirm', id, message });
  });

  const resolvePersona = (name: string): Persona => {
    const found = project?.state.personas().find((p) => p.name === name) ?? personaStore.get(name);
    if (found) return found;
    throw new OrqError('NOT_FOUND', `A função ${name} não existe. Veja as disponíveis com orq persona list.`);
  };

  const createTerminalFor = async (input: CreateTerminalInput): Promise<Session> => {
    const current = requireProject();
    if (input.agent === 'agy') {
      const res = await ensureAgyGlobalHook({ command: agyStopHookCommand(opts.cliScript), confirm: requestConfirm, ...(opts.agyHooksFile ? { hooksFile: opts.agyHooksFile } : {}) });
      if (res === 'declined') throw new OrqError('USAGE', 'Sem o hook global, o Orquestra não sabe quando o agy termina. O terminal não foi criado.');
    }
    const session = orquestra!.createTerminal({ ...input, cwd: input.cwd ?? current.dir });
    recordPids(); changed();
    return session;
  };

  const snapshot = (current: OpenProject): ProjectSnapshot => ({
    ...(opts.eventSequence ? { eventSequence: opts.eventSequence() } : {}),
    dir: current.dir, name: current.name, terminals: orquestra!.sessions().map(info),
    notes: orquestra!.notes.list().map(noteInfo), edges: orquestra!.topology.edges(),
    layout: current.state.layout(), viewport: current.state.viewport(),
    queues: Object.fromEntries(orquestra!.sessions().map((s) => [s.name, orquestra!.broker.list(s.name)])),
    groups: current.state.grouping.list(),
  });

  const groupHelpers = createGroupHelpers({ requireProject, getOrquestra: () => orquestra!, capture, changed, send: opts.send });
  const ctx: BridgeContext = {
    opts, recent, settings, personaStore, modelCatalog, batcher, removedTerminals,
    getOrquestra: () => orquestra!, getProject: () => project, setProject: (next) => { project = next; },
    requireProject, requireSession, capture, snapshot, changed, noteInfo, info,
    recordPids, resolvePersona, createTerminalFor, ...groupHelpers,
    abortQuality: () => qualityController.abort(),
  };

  function onAgentNote(note: Note, createdBy: string | null, renamedFrom?: string): void {
    if (renamedFrom) return opts.send({ kind: 'event', event: { type: 'note.changed', note: noteInfo(note), connectedTo: null, rect: null, renamedFrom } });
    let rect = null;
    if (createdBy && project) {
      const author = project.state.rectOf(createdBy) ?? { x: 80, y: 80, ...TERMINAL_SIZE };
      rect = { ...placeBeside(author, Object.values(project.state.layout()), NOTE_SIZE), ...NOTE_SIZE };
      project.state.place(note.name, rect);
    }
    changed();
    opts.send({ kind: 'event', event: { type: 'note.changed', note: noteInfo(note), connectedTo: createdBy, rect } });
  }

  const regent = createRegentHandler(ctx);
  const projectController = createProjectController(ctx);
  orquestra = await createOrquestra({
    pipePath: opts.pipePath, dataDir: opts.dataDir, cliScript: opts.cliScript, adapters: opts.adapters,
    log: opts.log, ptyHost: opts.ptyHost, readyQuietMs: opts.readyQuietMs, claudeDir: opts.claudeDir,
    agySettingsFile: opts.agySettingsFile, agyModels: () => modelCatalog.get().agy.models,
    listPipes: opts.listPipes, backgroundJobPollMs: opts.backgroundJobPollMs,
    regent, browser, browserNodes: () => project?.state.browserNodes() ?? [],
    usage: usageController.getProviderUsage, quality: (params) => qualityController.measure(params.refresh === true),
    onEvent: (event) => {
      if (event.type === 'output') return batcher.push(event.name, event.data);
      if (event.type === 'state') { if (orquestra && event.state === 'exited') recordPids(); return opts.send({ kind: 'event', event: { type: 'terminal.state', name: event.name, state: event.state, queued: event.queued } }); }
      if (event.type === 'queue') return opts.send({ kind: 'event', event: { type: 'terminal.queue', name: event.name, entries: event.entries } });
      if (event.type === 'answered') return opts.send({ kind: 'event', event: { type: 'ask.answered', askId: event.askId, from: event.asker, target: event.target } });
      if (event.type === 'notice') return opts.send({ kind: 'event', event: { type: 'terminal.notice', name: event.name, message: event.message } });
      if (event.type === 'agent-session') return changed();
      if (event.type === 'model') { changed(); return opts.send({ kind: 'event', event: { type: 'terminal.model', name: event.name, model: event.model } }); }
      if (event.type === 'note') return onAgentNote(event.note, event.createdBy, event.renamedFrom);
      if (event.type === 'removed') { removedTerminals.remember(project, event.name); batcher.drop(event.name); recordPids(); project?.state.forget(event.name); changed(); return opts.send({ kind: 'event', event: { type: 'terminal.removed', name: event.name } }); }
      if (event.type === 'turn') return opts.send({ kind: 'event', event: { type: 'terminal.turn', name: event.name, owner: event.owner, outcome: event.outcome } });
      const unexpected: never = event;
      opts.log.warn({ event: unexpected }, 'evento do núcleo desconhecido; ignorado');
    },
  });

  if (ownsModelCatalog) {
    void modelCatalog.refreshIfNeeded().catch((err) => opts.log.warn({ err }, 'falha na atualização inicial do catálogo de modelos'));
  }

  const handlers: Handlers = {
    ...createGroupHandlers(ctx), ...projectController.handlers, ...usageController.handlers,
    ...qualityController.handlers, ...createTerminalHandlers(ctx), ...createNoteHandlers(ctx),
    ...createAppHandlers(ctx),
  };

  return {
    async handle(message) {
      if (message.kind === 'portal-reply') { const p = portalCalls.get(message.id); if (message.ok) p?.resolve(message.result); else p?.reject(new OrqError(message.error?.code ?? 'APP_UNAVAILABLE', message.error?.message ?? 'Navegador indisponível.')); return; }
      if (message.kind === 'confirm-reply') { confirms.get(message.id)?.(message.approved); confirms.delete(message.id); return; }
      try {
        if (!isHostMethod(message.method)) throw new OrqError('USAGE', `Comando desconhecido: ${message.method}.`);
        const params = parseHostParams(message.method, message.params);
        if (!(message.method in handlers)) throw new OrqError('USAGE', 'Comando de workspace requer o gerenciador.');
        opts.send({ kind: 'response', id: message.id, ok: true, result: await (handlers[message.method as BridgeMethod] as (p: unknown) => Promise<unknown>)(params) });
      } catch (error) {
        if (error instanceof OrqError) return opts.send({ kind: 'response-error', id: message.id, error: { code: error.code, message: error.message } });
        opts.log.error({ err: error, method: message.method }, 'erro interno no comando');
        opts.send({ kind: 'response-error', id: message.id, error: { code: 'INTERNAL', message: 'Erro interno do Orquestra. Veja o log.' } });
      }
    },
    dispatchForTest: (method, params, caller) => orquestra!.dispatchForTest(method, params, caller, new AbortController().signal),
    abortBackground: () => qualityController.abortBackground(),
    async close() {
      closing = true;
      const waitQualityClose = qualityController.beginClose();
      for (const [id, p] of [...portalCalls]) { opts.send({ kind: 'portal-cancel', id }); p.reject(new OrqError('APP_UNAVAILABLE', 'Workspace encerrado.')); }
      unsubscribeModelCatalog();
      if (ownsModelCatalog) await modelCatalog.close();
      usageController.abort();
      for (const resolve of confirms.values()) resolve(false);
      confirms.clear();
      projectController.detachProject();
      batcher.flush();
      await orquestra!.close();
      await waitQualityClose();
      opts.onPids?.([]);
    },
  };
}
