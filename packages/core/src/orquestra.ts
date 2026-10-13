import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultMonitor, OrqError, reservedArgError, type QueueEntry, type SessionState } from '@orquestra/shared';
import type { AgentAdapter } from './adapters/types.js';
import { AskBroker } from './ask-broker.js';
import { childEnv, prependPath } from './env.js';
import { createHandlers, type RegentHandler, type RegentMethod } from './handlers.js';
import type { Logger } from './log.js';
import { NoteStore, USER_AUTHOR, type Note } from './notes.js';
import { startPipeServer } from './pipe-server.js';
import { nodePtyHost, type PtyHost, type PtyProcess } from './pty-host.js';
import { resolveExecutable } from './resolve-exe.js';
import { Session, type TurnFailure, type TurnOwner } from './session.js';
import { Topology } from './topology.js';
import type { BrowserHandler, BrowserNode } from '@orquestra/shared';

export { type RegentHandler, type RegentMethod } from './handlers.js';

export const RESUME_GRACE_MS = 10_000;

export type TerminalDescriptor = { id: string; name: string; agent: string; cwd: string; args: string[]; resume: boolean; agentSessionId: string | null; regente: boolean; persona: string | null; monitor: boolean; unloaded?: boolean };
export type CreateTerminalInput = { name: string; agent: string; cwd: string; id?: string; args?: string[]; resume?: boolean; agentSessionId?: string | null; regente?: boolean; persona?: string | null; monitor?: boolean; unloaded?: boolean };
export type TerminalChanges = { newName?: string; cwd?: string; args?: string[]; resume?: boolean; regente?: boolean; monitor?: boolean };

export type OrquestraOptions = {
  pipePath: string;
  dataDir: string;
  /** Caminho sem espaços do orq.mjs instalado (installCli), usado nos hooks e no Path dos terminais. */
  cliScript: string;
  adapters: Record<string, AgentAdapter>;
  log: Logger;
  ptyHost?: PtyHost;
  readyQuietMs?: number;
  typingGuardMs?: number;
  resumeGraceMs?: number;
  onEvent?: (event: OrquestraEvent) => void;
  regent?: RegentHandler;
  browser?: BrowserHandler;
  browserNodes?: () => BrowserNode[];
};

export type OrquestraEvent =
  | { type: 'output'; name: string; data: string }
  | { type: 'state'; name: string; state: SessionState; queued: number }
  | { type: 'queue'; name: string; entries: QueueEntry[] }
  | { type: 'removed'; name: string }
  | { type: 'agent-session'; name: string }
  | { type: 'notice'; name: string; message: string }
  /** Nota criada ou alterada pelo orq; createdBy é o terminal autor quando a nota nasce. */
  | { type: 'note'; note: Note; createdBy: string | null }
  | { type: 'turn'; name: string; owner: TurnOwner; outcome: 'ended' | 'failed' };

export type Orquestra = {
  readonly pipePath: string;
  readonly topology: Topology;
  readonly notes: NoteStore;
  readonly broker: AskBroker;
  createTerminal(input: CreateTerminalInput): Session;
  describeTerminals(): TerminalDescriptor[];
  removeTerminal(name: string, opts?: { reason?: string }): Promise<void>;
  /** Entrega o texto de uma função a um terminal. */
  brief(target: string, from: string, text: string): void;
  /** Troca o nome mantendo conexões e o token; recusa se houver pedidos na fila do terminal. */
  renameTerminal(name: string, newName: string): Session;
  /** Encerra e lança de novo o mesmo agente na mesma pasta, com o mesmo nome e as mesmas conexões. */
  restartTerminal(name: string): Promise<Session>;
  unloadTerminal(name: string): Promise<Session>;
  /** Edita nome, pasta, argumentos e retomada de um terminal, relançando quando preciso. */
  updateTerminal(name: string, changes: TerminalChanges): Promise<Session>;
  queue(name: string): QueueEntry[];
  connect(a: string, b: string): void;
  disconnect(a: string, b: string): void;
  session(name: string): Session | undefined;
  sessions(): Session[];
  tokenFor(name: string): string | undefined;
  /** Notas da interface: o autor é USER_AUTHOR e não geram evento 'note'. */
  createNote(name: string, content: string): Note;
  /** baseRevision: revisão em que a edição começou; null sobrescreve. Revisão antiga lança CONFLICT. */
  saveNote(name: string, content: string, baseRevision: number | null): Note;
  /** Tira a nota do canvas junto com as conexões. */
  removeNote(name: string): void;
  /** Põe no canvas uma nota lida do workspace, com id e revisão. */
  restoreNote(note: Note): void;
  /** Só para testes: chama os comandos do orq como se viessem do pipe. */
  readonly dispatchForTest: ReturnType<typeof createHandlers>;
  close(): Promise<void>;
};

const FAILURE_TEXT: Record<TurnFailure, string> = {
  interrupted: 'o turno foi interrompido',
  exited: 'o terminal foi encerrado',
  'no-answer': 'a resposta não foi encontrada',
  'agent-error': 'o agente parou com um erro (limite de uso ou falha da API)',
};

export async function createOrquestra(opts: OrquestraOptions): Promise<Orquestra> {
  const host = opts.ptyHost ?? nodePtyHost;
  const topology = new Topology();
  const notes = new NoteStore();
  const sessions = new Map<string, { session: Session; token: string; stopOutput: () => void }>();
  const tokens = new Map<string, string>();
  const broker = new AskBroker({
    resolveTarget: (name) => sessions.get(name)?.session,
    log: opts.log.child({ component: 'broker' }),
    typingGuardMs: opts.typingGuardMs,
    // emitQueue só é chamada depois, quando o broker já existe.
    onQueueChange: (target) => emitQueue(target),
  });
  const configs = new Map<string, Omit<TerminalDescriptor, 'name'>>();
  const emit = (event: OrquestraEvent) => opts.onEvent?.(event);
  const emitState = (name: string) => {
    const session = sessions.get(name)?.session;
    if (session) emit({ type: 'state', name, state: session.state, queued: broker.queued(name) });
  };
  const emitQueue = (target: string) => {
    emit({ type: 'queue', name: target, entries: broker.list(target) });
    emitState(target);
  };
  const dispatch = createHandlers({
    topology,
    notes,
    broker,
    session: (name) => sessions.get(name)?.session,
    onNoteChanged: (note, createdBy) => emit({ type: 'note', note, createdBy }),
    isRegent: (name) => configs.get(name)?.regente ?? false,
    regent: opts.regent,
    browser: opts.browser,
    browserNodes: opts.browserNodes,
  });
  const server = await startPipeServer({
    pipePath: opts.pipePath,
    authenticate: (token) => {
      const name = tokens.get(token);
      return name ? { session: name } : undefined;
    },
    dispatch,
    log: opts.log.child({ component: 'pipe' }),
  });
  const binDir = dirname(opts.cliScript).replaceAll('/', '\\');

  function createTerminal(input: CreateTerminalInput): Session {
    const adapter = opts.adapters[input.agent];
    if (!adapter) throw new OrqError('USAGE', `Tipo de agente desconhecido: ${input.agent}. Use ${Object.keys(opts.adapters).join(', ')}.`);
    const reserved = reservedArgError(input.agent, input.args ?? []);
    if (reserved) throw new OrqError('USAGE', reserved);
    // Sem esta checagem, o ConPTY falha com "Cannot create process, error code: 267".
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
      throw new OrqError('USAGE', `A pasta ${input.cwd} não existe. Crie a pasta ou escolha outra.`);
    }
    topology.add(input.name, 'terminal');
    try {
      return spawnTerminal(input, adapter);
    } catch (error) {
      // Falha ao lançar (agente não instalado): o nome volta a ficar livre.
      topology.remove(input.name);
      throw error;
    }
  }

  function spawnTerminal(input: CreateTerminalInput, adapter: AgentAdapter): Session {
    const id = input.id ?? randomUUID();
    const resume = input.resume ?? true;
    const resumeSessionId = resume ? (input.agentSessionId ?? null) : null;
    const token = randomBytes(32).toString('hex');
    // Pasta por lançamento: o id do terminal se repete a cada relançamento.
    const sessionDir = join(opts.dataDir, 'sessions', randomUUID());
    mkdirSync(sessionDir, { recursive: true });
    const launch = adapter.launch({
      cwd: input.cwd,
      sessionDir,
      hookCommand: (event) => `node ${opts.cliScript} hook ${adapter.kind} ${event}`,
      resumeSessionId,
      terminalName: input.name,
      regente: input.regente ?? false,
    });
    const args = input.args ?? [];
    const env = prependPath({ ...childEnv(process.env), ...launch.env, ORQ_PIPE: opts.pipePath, ORQ_TOKEN: token }, binDir);
    let pty: PtyProcess;
    if (input.unloaded) {
      pty = { pid: 0, write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {}, onError: () => {}, kill: async () => {} };
    } else {
      const executable = resolveExecutable(launch.command);
      pty = host.spawn({ file: executable.file, args: [...executable.argsPrefix, ...launch.args, ...args], cwd: input.cwd, env });
    }
    const log = opts.log.child({ session: input.name, sessionId: id, agent: adapter.kind });
    const agentSessionId = input.unloaded ? input.agentSessionId ?? null : launch.agentSessionId ?? input.agentSessionId ?? null;
    const session = new Session({ id, name: input.name, adapter, pty, cwd: input.cwd, log, readyQuietMs: opts.readyQuietMs, agentSessionId, unloaded: input.unloaded });
    // session.name, não input.name: o terminal pode ser renomeado depois.
    const stopOutput = session.onOutput((data) => emit({ type: 'output', name: session.name, data }));
    session.on('state', () => {
      broker.sessionChanged(session.name);
      emitState(session.name);
    });
    session.on('turnEnded', (event) => {
      if (event.owner === 'broker' && event.answer !== null) broker.turnEnded(session.name, event.answer);
      emit({ type: 'turn', name: session.name, owner: event.owner, outcome: 'ended' });
    });
    session.on('turnFailed', (event) => {
      if (event.owner === 'broker') broker.turnFailed(session.name, FAILURE_TEXT[event.reason]);
      emit({ type: 'turn', name: session.name, owner: event.owner, outcome: 'failed' });
    });
    session.on('agentSession', (agentId) => {
      const config = configs.get(session.name);
      if (config) config.agentSessionId = agentId;
      emit({ type: 'agent-session', name: session.name });
    });
    if (resumeSessionId && !input.unloaded) watchResume(session, Date.now());
    sessions.set(input.name, { session, token, stopOutput });
    const regente = input.regente ?? false;
    const persona = input.persona ?? null;
    const monitor = input.monitor ?? defaultMonitor(input.agent);
    configs.set(input.name, { id, agent: input.agent, cwd: input.cwd, args, resume, agentSessionId, regente, persona, monitor, ...(input.unloaded ? { unloaded: true } : {}) });
    if (!input.unloaded) tokens.set(token, input.name);
    log.info({ cwd: input.cwd, resumeSessionId, args }, 'terminal criado');
    return session;
  }

  /** Spec, seção 5: retomada que falha (agente sai logo) vira sessão nova, com aviso no nó. */
  function watchResume(session: Session, startedAt: number): void {
    session.on('state', (state) => {
      if (state !== 'exited' || Date.now() - startedAt > (opts.resumeGraceMs ?? RESUME_GRACE_MS)) return;
      const name = session.name;
      const config = configs.get(name);
      if (!config || config.unloaded || sessions.get(name)?.session !== session) return;
      opts.log.warn({ session: name }, 'retomada falhou; relançando sem retomar');
      void relaunchFresh(name, config);
    });
  }

  async function relaunchFresh(name: string, config: Omit<TerminalDescriptor, 'name'>): Promise<void> {
    const neighbors = topology.neighbors(name);
    await removeTerminal(name, { announce: false });
    try {
      createTerminal({ name, agent: config.agent, cwd: config.cwd, id: config.id, args: config.args, resume: config.resume, agentSessionId: null, regente: config.regente, persona: config.persona, monitor: config.monitor });
      for (const neighbor of neighbors) if (topology.kindOf(neighbor)) topology.connect(name, neighbor);
      emit({ type: 'notice', name, message: 'a sessão anterior não pôde ser retomada. O terminal começou uma sessão nova.' });
      emitState(name);
    } catch (error) {
      opts.log.error({ err: error, session: name }, 'falha ao relançar sem retomar');
      emit({ type: 'removed', name });
    }
  }

  /** announce: false no reinício, para a interface não apagar o nó nem as conexões dele. */
  async function removeTerminal(name: string, removeOpts: { announce?: boolean; reason?: string } = {}): Promise<void> {
    const entry = sessions.get(name);
    if (!entry) return;
    broker.sessionRemoved(name, removeOpts.reason);
    sessions.delete(name);
    tokens.delete(entry.token);
    topology.remove(name);
    configs.delete(name);
    entry.stopOutput();
    entry.session.removeAllListeners();
    if (removeOpts.announce !== false) emit({ type: 'removed', name });
    await entry.session.kill();
  }

  function renameTerminal(name: string, newName: string): Session {
    const entry = sessions.get(name);
    if (!entry) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
    if (name === newName) return entry.session;
    if (broker.queued(name) > 0) throw new OrqError('USAGE', `${name} tem pedidos na fila. Espere a fila esvaziar para renomear.`);
    topology.rename(name, newName);
    sessions.delete(name);
    sessions.set(newName, entry);
    if (tokens.has(entry.token)) tokens.set(entry.token, newName);
    const config = configs.get(name)!;
    configs.delete(name);
    configs.set(newName, config);
    entry.session.rename(newName);
    broker.renameAsker(name, newName);
    // Sem evento 'removed': a interface troca o nó pelo resultado do comando (replaceTerminal).
    emitState(newName);
    return entry.session;
  }

  async function restartTerminal(name: string, keepUnloaded = false): Promise<Session> {
    const config = configs.get(name);
    if (!config) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
    const neighbors = topology.neighbors(name);
    await removeTerminal(name, { announce: false });
    let session: Session;
    try {
      session = createTerminal({ name, agent: config.agent, cwd: config.cwd, id: config.id, args: config.args, resume: config.resume, agentSessionId: config.agentSessionId, regente: config.regente, persona: config.persona, monitor: config.monitor, unloaded: keepUnloaded });
    } catch (error) {
      // O terminal antigo já saiu: sem este aviso a interface ficaria com um nó que não existe mais.
      emit({ type: 'removed', name });
      throw error;
    }
    for (const neighbor of neighbors) if (topology.kindOf(neighbor)) topology.connect(name, neighbor);
    return session;
  }

  async function unloadTerminal(name: string): Promise<Session> {
    const entry = sessions.get(name);
    const config = configs.get(name);
    if (!entry || !config) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
    if (config.unloaded) return entry.session;
    config.unloaded = true;
    broker.sessionRemoved(name, `${name} foi descarregado`);
    tokens.delete(entry.token);
    entry.stopOutput();
    entry.session.removeAllListeners();
    await entry.session.unload();
    emitState(name);
    opts.log.info({ session: name }, 'terminal descarregado; configuração e conexões preservadas');
    return entry.session;
  }

  async function updateTerminal(name: string, changes: TerminalChanges): Promise<Session> {
    const config = configs.get(name);
    if (!config) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
    const newName = changes.newName ?? name;
    const cwd = changes.cwd ?? config.cwd;
    const args = changes.args ?? config.args;
    if (newName !== name && topology.kindOf(newName)) throw new OrqError('USAGE', `Já existe um nó chamado ${newName}. Escolha outro nome.`);
    if (cwd !== config.cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) {
      throw new OrqError('USAGE', `A pasta ${cwd} não existe. Crie a pasta ou escolha outra.`);
    }
    const reserved = reservedArgError(config.agent, args);
    if (reserved) throw new OrqError('USAGE', reserved);
    if (newName !== name && broker.queued(name) > 0) throw new OrqError('USAGE', `${name} tem pedidos na fila. Espere a fila esvaziar para renomear.`);

    const relaunch = cwd !== config.cwd || args.length !== config.args.length || args.some((arg, index) => arg !== config.args[index]);
    const changed = Object.keys(changes).filter((key) => changes[key as keyof TerminalChanges] !== undefined);
    if (newName !== name) renameTerminal(name, newName);
    config.regente = changes.regente ?? config.regente;
    config.resume = changes.resume ?? config.resume;
    config.monitor = changes.monitor ?? config.monitor;
    let session = sessions.get(newName)!.session;
    if (relaunch) {
      config.cwd = cwd;
      config.args = args;
      session = await restartTerminal(newName, Boolean(config.unloaded));
    }
    opts.log.info({ session: newName, changed, relaunched: relaunch }, 'terminal atualizado');
    return session;
  }

  return {
    pipePath: opts.pipePath,
    topology,
    notes,
    broker,
    createTerminal,
    describeTerminals: () =>
      [...configs.entries()].map(([name, config]) => ({
        id: config.id,
        name,
        agent: config.agent,
        cwd: config.cwd,
        args: config.args,
        resume: config.resume,
        agentSessionId: config.agentSessionId,
        regente: config.regente,
        persona: config.persona,
        monitor: config.monitor,
        ...(config.unloaded ? { unloaded: true } : {}),
      })),
    removeTerminal: (name, opts) => removeTerminal(name, { reason: opts?.reason }),
    brief: (target, from, text) => {
      const session = sessions.get(target)?.session;
      if (!session) throw new OrqError('NOT_FOUND', `Terminal ${target} não existe.`);
      if (!session.acceptsPrompts) throw new OrqError('USAGE', 'O shell não recebe funções.');
      broker.brief(target, from, text);
    },
    renameTerminal,
    restartTerminal,
    unloadTerminal,
    updateTerminal,
    queue: (name) => broker.list(name),
    connect: (a, b) => topology.connect(a, b),
    disconnect: (a, b) => topology.disconnect(a, b),
    session: (name) => sessions.get(name)?.session,
    sessions: () => [...sessions.values()].map((entry) => entry.session),
    tokenFor: (name) => sessions.get(name)?.token,
    dispatchForTest: dispatch,
    createNote: (name, content) => {
      topology.add(name, 'note');
      try {
        return notes.create(name, content, USER_AUTHOR);
      } catch (error) {
        topology.remove(name);
        throw error;
      }
    },
    saveNote: (name, content, baseRevision) => notes.save(name, content, baseRevision, USER_AUTHOR),
    removeNote: (name) => {
      if (topology.kindOf(name) !== 'note') throw new OrqError('NOT_FOUND', `A nota ${name} não existe.`);
      notes.remove(name);
      topology.remove(name);
    },
    restoreNote: (note) => {
      topology.add(note.name, 'note');
      notes.restore([note]);
    },
    close: async () => {
      await Promise.all([...sessions.keys()].map((name) => removeTerminal(name)));
      await server.close();
    },
  };
}
