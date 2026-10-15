import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultMonitor, OrqError, reservedArgError, type QueueEntry, type SessionState } from '@orquestra/shared';
import type { AgentAdapter } from './adapters/types.js';
import { AskBroker } from './ask-broker.js';
import { CLAUDE_CLEAR_INPUT, ClaudeStatusWatcher } from './adapters/claude-status.js';
import { BackgroundJobWatcher, backgroundJobNotice, claudeConfigDir, findBackgroundJob, type ListPipes } from './background-job.js';
import { childEnv, prependPath } from './env.js';
import { codexRolloutMatchesTerminal } from './codex-rollout-watcher.js';
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
const DRAFT_NOTICE = 'Há um rascunho na caixa de entrada; envie ou apague para liberar a fila.';
/** Quantos lançamentos por terminal entram no vínculo com o job em segundo plano. */
const MAX_SESSION_DIRS = 20;

export type TerminalDescriptor = { id: string; name: string; agent: string; cwd: string; args: string[]; resume: boolean; agentSessionId: string | null; regente: boolean; persona: string | null; monitor: boolean; unloaded?: boolean; /** Pastas de sessão de cada lançamento (vínculo com o job em segundo plano); não vai para o workspace. */ sessionDirs?: string[] };
export type CreateTerminalInput = { name: string; agent: string; cwd: string; id?: string; args?: string[]; resume?: boolean; agentSessionId?: string | null; regente?: boolean; persona?: string | null; monitor?: boolean; unloaded?: boolean; sessionDirs?: string[] };
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
  /** Pasta de configuração do Claude Code (jobs em segundo plano). Padrão: CLAUDE_CONFIG_DIR ou ~/.claude. */
  claudeDir?: string;
  /** Intervalo da verificação periódica dos jobs em segundo plano (padrão 5 s). */
  backgroundJobPollMs?: number;
  /** Intervalo da leitura do status da sessão do Claude enquanto há turno em curso (padrão 200 ms). */
  claudeStatusPollMs?: number;
  /** Tolerância ao hook de fim de turno depois que o status do Claude volta a idle (padrão 2,5 s). */
  claudeIdleGraceMs?: number;
  /** Lista os named pipes do sistema (o daemon abre um por conversa viva); injetável nos testes. */
  listPipes?: ListPipes;
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
  | { type: 'answered'; askId: string; asker: string; target: string }
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
  const sessions = new Map<string, { session: Session; token: string; stopOutput: () => void; stopWatcher: () => void }>();
  const claudeDir = opts.claudeDir ?? claudeConfigDir();
  const tokens = new Map<string, string>();
  const broker = new AskBroker({
    resolveTarget: (name) => sessions.get(name)?.session,
    log: opts.log.child({ component: 'broker' }),
    typingGuardMs: opts.typingGuardMs,
    // emitQueue só é chamada depois, quando o broker já existe.
    onQueueChange: (target) => emitQueue(target),
    onAnswered: (info) => emit({ type: 'answered', ...info }),
    onDraftBlocked: (target) => emit({ type: 'notice', name: target, message: DRAFT_NOTICE }),
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
    let resumeSessionId = resume ? (input.agentSessionId ?? null) : null;
    let ignoredCodexResume = false;
    if (adapter.kind === 'codex' && resumeSessionId && codexRolloutMatchesTerminal(resumeSessionId, input.cwd, id) === false) {
      opts.log.warn({ terminal: input.name, terminalId: id, cwd: input.cwd, sessionId: resumeSessionId }, 'resume do Codex ignorado: rollout pertence a outro cwd ou terminal');
      resumeSessionId = null;
      ignoredCodexResume = true;
    }
    // Pastas de sessão dos lançamentos anteriores deste terminal: o job em segundo plano nasce com outro
    // sessionId e só o --settings do respawnFlags o liga ao terminal. O lançamento atual entra mais abaixo.
    const sessionDirs = [...(input.sessionDirs ?? [])];
    // Retomar uma conversa que o daemon mantém em segundo plano abriria uma segunda cópia ("nome (2)")
    // sem pipe nem hooks: o terminal nasce descarregado e o aviso explica como trazê-la de volta.
    let unloaded = input.unloaded ?? false;
    if (!unloaded && adapter.kind === 'claude' && resumeSessionId && findBackgroundJob({ claudeDir, sessionDirs, sessionId: resumeSessionId, listPipes: opts.listPipes })) {
      unloaded = true;
      opts.log.warn({ session: input.name, sessionId: resumeSessionId }, 'sessão presa a um job em segundo plano; terminal não retomado para não abrir uma segunda cópia');
    }
    const token = randomBytes(32).toString('hex');
    // Pasta por lançamento: o id do terminal se repete a cada relançamento.
    const sessionDir = join(opts.dataDir, 'sessions', randomUUID());
    mkdirSync(sessionDir, { recursive: true });
    sessionDirs.push(sessionDir);
    if (sessionDirs.length > MAX_SESSION_DIRS) sessionDirs.splice(0, sessionDirs.length - MAX_SESSION_DIRS);
    const launch = adapter.launch({
      cwd: input.cwd,
      sessionDir,
      hookCommand: (event) => `node "${opts.cliScript}" hook ${adapter.kind} ${event}`,
      resumeSessionId,
      terminalName: input.name,
      terminalId: id,
      regente: input.regente ?? false,
    });
    const args = input.args ?? [];
    const env = prependPath({ ...childEnv(process.env), ...launch.env, ORQ_PIPE: opts.pipePath, ORQ_TOKEN: token }, binDir);
    let pty: PtyProcess;
    if (unloaded) {
      pty = { pid: 0, write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {}, onError: () => {}, kill: async () => {} };
    } else {
      const executable = resolveExecutable(launch.command);
      pty = host.spawn({ file: executable.file, args: [...executable.argsPrefix, ...launch.args, ...args], cwd: input.cwd, env });
    }
    const log = opts.log.child({ session: input.name, sessionId: id, agent: adapter.kind });
    const agentSessionId = unloaded ? input.agentSessionId ?? null : launch.agentSessionId ?? (ignoredCodexResume ? null : input.agentSessionId ?? null);
    const session = new Session({ id, name: input.name, adapter, pty, cwd: input.cwd, log, readyQuietMs: opts.readyQuietMs, agentSessionId, unloaded, idleGraceMs: opts.claudeIdleGraceMs });
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
    session.on('draft', (pending) => {
      if (pending) return;
      emit({ type: 'notice', name: session.name, message: '' });
      broker.sessionChanged(session.name);
    });
    session.on('agentSession', (agentId) => {
      const config = configs.get(session.name);
      if (config) config.agentSessionId = agentId;
      emit({ type: 'agent-session', name: session.name });
    });
    if (resumeSessionId && !unloaded) watchResume(session, Date.now(), sessionDirs);
    const stopJobWatcher = adapter.kind === 'claude' ? watchBackgroundJob(session, log, sessionDirs) : () => {};
    const stopStatusWatcher = adapter.kind === 'claude' && !unloaded ? watchClaudeStatus(session, log) : () => {};
    const stopWatcher = () => { stopJobWatcher(); stopStatusWatcher(); };
    sessions.set(input.name, { session, token, stopOutput, stopWatcher });
    const regente = input.regente ?? false;
    const persona = input.persona ?? null;
    const monitor = input.monitor ?? defaultMonitor(input.agent);
    configs.set(input.name, { id, agent: input.agent, cwd: input.cwd, args, resume, agentSessionId, regente, persona, monitor, sessionDirs, ...(unloaded ? { unloaded: true } : {}) });
    if (!unloaded) tokens.set(token, input.name);
    log.info({ cwd: input.cwd, resumeSessionId, args }, 'terminal criado');
    return session;
  }

  /**
   * Esc antes do primeiro token: o Claude Code desfaz o turno sem Stop nem "Interrupted". O status da sessão
   * (~/.claude/sessions/<pid>.json) volta de busy para idle; sem hook de fim de turno, o turno falha como
   * interrompido e a fila destrava. Só lê o arquivo enquanto o terminal está ocupado.
   */
  function watchClaudeStatus(session: Session, log: Logger): () => void {
    const watcher = new ClaudeStatusWatcher({
      sessionsDir: join(claudeDir, 'sessions'),
      who: () => ({ pid: session.pid, sessionId: session.agentSessionId }),
      log,
      pollMs: opts.claudeStatusPollMs,
      onBusy: () => session.agentBusy(),
      // Só o pedido do broker: o texto devolvido num turno do próprio usuário é dele, para editar.
      onIdle: () => session.agentIdle((owner) => { if (owner === 'broker') session.sendControl(CLAUDE_CLEAR_INPUT); }),
    });
    const sync = () => { if (session.state === 'busy') watcher.start(); else watcher.stop(); };
    session.on('state', sync);
    sync();
    return () => { session.off('state', sync); watcher.stop(); };
  }

  /**
   * A conversa do Claude foi para o daemon: o ORQ_PIPE e o ORQ_TOKEN dela ficaram presos ao app antigo,
   * então nem hooks nem pedidos chegam. Avisa no terminal e deixa o broker recusar a entrega.
   */
  function watchBackgroundJob(session: Session, log: Logger, sessionDirs: string[]): () => void {
    const notify = (job: { id8: string; state: string } | null) => emit({ type: 'notice', name: session.name, message: job ? backgroundJobNotice(job) : '' });
    const watcher = new BackgroundJobWatcher({
      claudeDir,
      sessionId: () => session.agentSessionId,
      sessionDirs: () => sessionDirs,
      log,
      pollMs: opts.backgroundJobPollMs,
      listPipes: opts.listPipes,
      onChange: (job) => {
        session.backgroundJob = job;
        notify(job);
        broker.backgroundJobChanged(session.name);
        emitState(session.name);
      },
      // O renderer perde o aviso ao recarregar ou reiniciar o nó: reemite enquanto o job existir.
      onPoll: notify,
    });
    watcher.start();
    return () => watcher.stop();
  }

  /** Spec, seção 5: retomada que falha (agente sai logo) vira sessão nova, com aviso no nó. */
  function watchResume(session: Session, startedAt: number, sessionDirs: string[]): void {
    session.on('state', (state) => {
      if (state !== 'exited' || Date.now() - startedAt > (opts.resumeGraceMs ?? RESUME_GRACE_MS)) return;
      const name = session.name;
      const config = configs.get(name);
      if (!config || config.unloaded || sessions.get(name)?.session !== session) return;
      // O /bg encerra o processo local logo depois de mover a conversa para o daemon: não é retomada que falhou,
      // e relançar abriria uma sessão nova (e perderia o vínculo com o job).
      const job = findBackgroundJob({ claudeDir, sessionDirs, sessionId: session.agentSessionId, listPipes: opts.listPipes });
      if (job) {
        opts.log.info({ session: name, job }, 'processo saiu porque a conversa foi para o segundo plano; não relança');
        return;
      }
      opts.log.warn({ session: name }, 'retomada falhou; relançando sem retomar');
      void relaunchFresh(name, config);
    });
  }

  async function relaunchFresh(name: string, config: Omit<TerminalDescriptor, 'name'>): Promise<void> {
    const neighbors = topology.neighbors(name);
    await removeTerminal(name, { announce: false });
    try {
      createTerminal({ name, agent: config.agent, cwd: config.cwd, id: config.id, args: config.args, resume: config.resume, agentSessionId: null, regente: config.regente, persona: config.persona, monitor: config.monitor, sessionDirs: config.sessionDirs });
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
    entry.stopWatcher();
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
      session = createTerminal({ name, agent: config.agent, cwd: config.cwd, id: config.id, args: config.args, resume: config.resume, agentSessionId: config.agentSessionId, regente: config.regente, persona: config.persona, monitor: config.monitor, sessionDirs: config.sessionDirs, unloaded: keepUnloaded });
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
    entry.stopWatcher();
    entry.session.backgroundJob = null;
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
        // Só o Claude tem conversa em segundo plano: os outros agentes não precisam do vínculo.
        ...(config.agent === 'claude' && config.sessionDirs?.length ? { sessionDirs: [...config.sessionDirs] } : {}),
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
