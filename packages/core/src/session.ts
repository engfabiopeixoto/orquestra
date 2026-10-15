import { EventEmitter } from 'node:events';
import { OrqError, type SessionState } from '@orquestra/shared';
import type { AgentAdapter, HookSignal, ScreenSignal } from './adapters/types.js';
import type { BackgroundJob } from './background-job.js';
import { CodexRolloutWatcher, type CodexRolloutEvent } from './codex-rollout-watcher.js';
import { incompleteEscapeTail } from './escape-tail.js';
import { writePrompt } from './input.js';
import type { Logger } from './log.js';
import type { PtyProcess } from './pty-host.js';
import { Screen } from './screen.js';
import { ScreenWatcher } from './screen-watcher.js';

export type TurnOwner = 'broker' | 'user';
export type TurnFailure = 'interrupted' | 'exited' | 'no-answer' | 'agent-error';

type SessionEvents = {
  state: [SessionState];
  turnEnded: [{ owner: TurnOwner; answer: string | null }];
  turnFailed: [{ owner: TurnOwner; reason: TurnFailure }];
  agentSession: [string];
  /** Há (true) ou deixou de haver (false) rascunho do usuário na caixa de entrada do agente. */
  draft: [boolean];
};

export type SessionOptions = {
  id: string;
  name: string;
  adapter: AgentAdapter;
  pty: PtyProcess;
  cwd: string;
  log: Logger;
  cols?: number;
  rows?: number;
  /** Silêncio na saída para considerar a TUI pronta: teclas enviadas antes disso são perdidas. */
  readyQuietMs?: number;
  /**
   * Enter vazio pode não abrir turno. Só esse caso provisório (e shell, sem hooks)
   * usa silêncio como fallback; trabalho de agente pode ficar silencioso por minutos.
   */
  userTurnQuietMs?: number;
  transcriptRetries?: number;
  transcriptRetryMs?: number;
  codexLongTurnWarningMs?: number;
  codexHome?: string;
  codexRolloutPollMs?: number;
  codexRolloutStartedAt?: number;
  agentSessionId?: string | null;
  unloaded?: boolean;
  /** Tolerância para o hook de fim de turno depois que o agente informa ocioso (agentIdle). Padrão 2,5 s. */
  idleGraceMs?: number;
};

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  name: string;
  readonly adapter: AgentAdapter;
  agentSessionId: string | null = null;
  /** Conversa do Claude mantida em segundo plano pelo daemon (sem pipe nem hooks); não altera o estado do terminal. */
  backgroundJob: BackgroundJob | null = null;

  private currentState: SessionState = 'starting';
  private owner: TurnOwner | null = null;
  private everIdle = false;
  private waitingByHook = false;
  private waitingOnScreen = false;
  private userInputAt = 0;
  private readyTimer: NodeJS.Timeout | undefined;
  private userTurnTimer: NodeJS.Timeout | undefined;
  private turnWarningTimer: NodeJS.Timeout | undefined;
  private provisionalUserTurn = false;
  private inputHasText = false;
  private pasting = false;
  /** Caracteres digitados na caixa (aproximado: o usuário também pode editar com setas e Ctrl+W). */
  private lineChars = 0;
  private submittedChars = 0;
  private submittedHadText = false;
  private draftPending = false;
  private draftChars = 0;
  private resolvingTurn: number | null = null;
  private idleGraceTimer: NodeJS.Timeout | undefined;
  private submittingTurn: number | null = null;
  private readonly completedHooks = new Set<string>();
  private codexTurnId: string | null = null;
  private readonly codexRolloutWatcher: CodexRolloutWatcher | null;
  /** Cresce a cada turno: uma continuação assíncrona de um turno antigo não pode mexer no atual. */
  private turnSeq = 0;
  private currentAskId: string | null = null;
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly screen: Screen;
  private cols: number;
  /** Sequência de escape aberta no fim da saída: vai junto do retrato (ver escape-tail.ts). */
  private pendingEscape = '';
  private rows: number;
  private readonly watcher: ScreenWatcher<ScreenSignal>;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.adapter = opts.adapter;
    this.agentSessionId = opts.agentSessionId ?? null;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.screen = new Screen(this.cols, this.rows);
    this.watcher = new ScreenWatcher(opts.adapter.screenRules);
    // Só o núcleo responde às consultas: a interface pode estar fechada ou somente leitura (e engole as dela).
    // Não conta como digitação do usuário.
    this.screen.onReply((data) => {
      this.opts.log.trace({ data: JSON.stringify(data) }, 'resposta do terminal');
      opts.pty.write(data);
    });
    opts.pty.onData((data) => this.handleOutput(data));
    opts.pty.onExit((code) => this.onExit(code));
    opts.pty.onError((error) => this.opts.log.warn({ err: error }, 'falha ao escrever no terminal'));
    if (opts.unloaded) this.currentState = 'exited';
    else this.armReady();
    this.codexRolloutWatcher = this.adapter.kind === 'codex' && !opts.unloaded
      ? new CodexRolloutWatcher({
        codexHome: opts.codexHome,
        cwd: opts.cwd,
        terminalName: opts.name,
        sessionId: this.agentSessionId,
        startedAt: opts.codexRolloutStartedAt,
        pollMs: opts.codexRolloutPollMs,
        log: opts.log,
        onEvent: (event) => this.onCodexRollout(event),
      })
      : null;
    this.codexRolloutWatcher?.start();
  }

  /** PID do processo raiz do terminal (para encerrar a árvore se o núcleo cair). */
  get pid(): number {
    return this.opts.pty.pid;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  get state(): SessionState {
    return this.currentState;
  }

  get lastUserInputAt(): number {
    return this.userInputAt;
  }

  get acceptsPrompts(): boolean {
    return this.adapter.acceptsPrompts;
  }

  screenText(lines?: number): string {
    return lines ? this.screen.tail(lines) : this.screen.text();
  }

  userInput(data: string): void {
    // Só em trace (desligado por padrão): registra o que o usuário digita, para depurar sequências de escape.
    this.opts.log.trace({ data: JSON.stringify(data) }, 'entrada da interface');
    this.userInputAt = Date.now();
    this.waitingByHook = false;
    this.opts.pty.write(data);
    // Guarda somente a presença de texto, sem registrar o conteúdo. Histórico é conservador:
    // um comando recuperado pode estar trabalhando mesmo sem produzir saída.
    for (const key of data.match(/\x1b\[[0-9;?]*[A-Za-z~]|[\s\S]/g) ?? []) {
      if (key === '\x1b[200~') { this.pasting = true; continue; }
      if (key === '\x1b[201~') { this.pasting = false; continue; }
      if (key === '\r' && !this.pasting) {
        if (this.currentState === 'idle' || this.currentState === 'starting') {
          const provisional = this.adapter.kind === 'codex' || !this.inputHasText || !this.acceptsPrompts;
          this.submittedHadText = this.inputHasText;
          this.submittedChars = this.lineChars;
          this.startTurn('user', null);
          this.provisionalUserTurn = provisional;
          if (provisional) this.armUserTurn();
          // Enviar com Enter resolve o rascunho que o agente devolveu (o texto vira o pedido do usuário). Depois de
          // abrir o turno: a fila é reavaliada ao limpar a marca e não pode encontrar o terminal ocioso.
          this.setDraft(false);
        }
        this.inputHasText = false;
        this.lineChars = 0;
      } else if (key === '\x03' || key === '\x15') {
        this.inputHasText = false;
        this.lineChars = 0;
        this.setDraft(false);
      } else if (key === '\x7f' || key === '\b') {
        if (this.lineChars > 0) this.lineChars--;
        // Apagou todo o rascunho devolvido: a caixa está vazia.
        if (this.draftPending && this.draftChars > 0 && --this.draftChars === 0) {
          this.inputHasText = false;
          this.setDraft(false);
        }
      } else if (key === '\x1b[A' || key === '\x1b[B' || (!key.startsWith('\x1b') && /[^\s\x00-\x1f\x7f]/.test(key))) {
        this.inputHasText = true;
        if (!key.startsWith('\x1b')) {
          this.lineChars++;
          if (this.draftPending) this.draftChars++;
        }
      }
    }
    this.refreshWaiting();
  }

  async injectPrompt(text: string, askId: string): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new OrqError('INTERNAL', `A sessão ${this.name} não está ociosa (${this.currentState}). O broker só injeta em idle.`);
    }
    const prepared = this.adapter.preparePrompt(text, { cwd: this.opts.cwd, askId });
    this.startTurn('broker', askId);
    const turn = this.turnSeq;
    this.submittingTurn = turn;
    try {
      await writePrompt({ write: (data) => {
        if (turn !== this.turnSeq || this.currentState === 'exited') throw new OrqError('PROMPT_FAILED', 'O turno terminou durante a escrita no terminal.');
        if (data === '\r') this.submittingTurn = null;
        this.opts.pty.write(data);
      } }, prepared, { encode: this.adapter.encodeInput?.bind(this.adapter) });
    } catch (error) {
      if (turn === this.turnSeq) this.endTurn();
      throw error;
    }
  }

  async handleHook(event: string, payload: unknown, agent: string = this.adapter.kind): Promise<void> {
    // O hook global do agy dispara em qualquer agy que herde o ORQ_TOKEN, por exemplo um agy rodado
    // como ferramenta dentro de outro agente: só valem hooks do mesmo tipo do terminal.
    if (agent !== this.adapter.kind) {
      this.opts.log.warn({ event, agent }, 'hook de outro tipo de agente; ignorado');
      return;
    }
    const signal = this.adapter.interpretHook(event, payload);
    if (signal.kind === 'ignored') {
      // Payload inteiro no log: é assim que se descobre mudança de formato de um CLI.
      this.opts.log.warn({ event, askId: this.currentAskId, payload }, 'hook ignorado');
      return;
    }
    this.opts.log.info({ event, signal: signal.kind, askId: this.currentAskId }, 'hook recebido');
    // Qualquer hook reconhecido mostra que o agente segue vivo e que o fim, se vier, vem pelo hook.
    this.agentBusy();
    if (this.currentState === 'exited') return;
    if ((signal.kind === 'turn-end' || signal.kind === 'turn-failed') && this.submittingTurn === this.turnSeq) {
      this.opts.log.warn({ event, askId: this.currentAskId }, 'fim de turno anterior durante a colagem; ignorado');
      return;
    }
    if (signal.kind === 'activity') {
      this.waitingByHook = false;
      this.waitingOnScreen = false;
      this.provisionalUserTurn = false;
      clearTimeout(this.userTurnTimer);
      if (this.owner === null) this.startTurn('user', null);
      else this.setState('busy', 'hook-activity');
      return;
    }
    if (signal.kind === 'turn-failed') {
      const owner = this.owner;
      if (owner !== null) {
        this.endTurn();
        this.emit('turnFailed', { owner, reason: 'agent-error' });
      }
      return;
    }
    if (signal.kind === 'waiting') {
      this.waitingByHook = true;
      this.refreshWaiting();
      return;
    }
    if (signal.kind === 'session-start') {
      this.learnAgentSession(signal.agentSessionId);
      return;
    }
    if (signal.kind !== 'turn-end') return;
    if (signal.completionId) {
      if (this.completedHooks.has(signal.completionId)) return;
      const hookTurnId = signal.completionId.slice(signal.completionId.lastIndexOf(':') + 1);
      if (this.adapter.kind === 'codex' && this.codexTurnId !== null && hookTurnId !== this.codexTurnId) {
        this.opts.log.warn({ event, askId: this.currentAskId, completionId: signal.completionId, activeTurnId: this.codexTurnId }, 'Stop atrasado de outro turno Codex; ignorado');
        return;
      }
      this.rememberCompletion(signal.completionId);
    }
    this.learnAgentSession(signal.agentSessionId);
    this.waitingByHook = false;
    const owner = this.owner;
    if (owner === null) {
      this.opts.log.warn({ event }, 'fim de turno sem turno em curso; ignorado');
      this.refreshWaiting();
      return;
    }
    if (owner === 'user') {
      this.endTurn();
      this.emit('turnEnded', { owner, answer: null });
      return;
    }
    clearTimeout(this.turnWarningTimer);
    const turn = this.turnSeq;
    if (this.resolvingTurn === turn) return;
    this.resolvingTurn = turn;
    let answer: string | null = null;
    try { answer = await this.resolveAnswer(signal); }
    catch (error) { this.opts.log.warn({ err: error, askId: this.currentAskId, turn }, 'falha ao ler resposta do turno'); }
    finally { if (this.resolvingTurn === turn) this.resolvingTurn = null; }
    if (turn !== this.turnSeq || this.owner !== owner) {
      this.opts.log.warn({ event, turn }, 'resposta de um turno que já terminou; descartada');
      return;
    }
    this.endTurn();
    if (answer === null) this.emit('turnFailed', { owner, reason: 'no-answer' });
    else this.emit('turnEnded', { owner, answer });
  }

  /**
   * Fonte externa (ex.: status da sessão do Claude) diz que o agente ficou ocioso. Se o hook de fim de turno não
   * chegar dentro da tolerância, o turno foi desfeito sem aviso (Esc antes do primeiro token): falha como
   * interrompido e libera a fila. `onExpired` roda antes, com o terminal ainda ocupado e a fila presa
   * (a hora de limpar a caixa de entrada que o agente restaurou).
   */
  agentIdle(onExpired?: (owner: TurnOwner) => void): void {
    if (this.owner === null || this.currentState === 'exited' || this.idleGraceTimer) return;
    const turn = this.turnSeq;
    this.idleGraceTimer = setTimeout(() => {
      this.idleGraceTimer = undefined;
      const owner = this.owner;
      if (turn !== this.turnSeq || owner === null || this.currentState === 'exited') return;
      this.opts.log.info({ owner, askId: this.currentAskId }, 'agente ocioso sem fim de turno; turno interrompido');
      onExpired?.(owner);
      // O agente devolve o texto de um pedido desfeito à caixa de entrada sem que ele passe pela digitação: sem
      // marcar, o próximo pedido da fila seria colado em cima do rascunho do usuário.
      if (owner === 'user' && this.submittedHadText) this.setDraft(true);
      this.endTurn();
      this.emit('turnFailed', { owner, reason: 'interrupted' });
    }, this.opts.idleGraceMs ?? 2500);
  }

  /** A caixa de entrada do agente tem texto do usuário que ele não enviou (devolvido depois de um Esc). */
  get hasDraft(): boolean {
    return this.draftPending;
  }

  private setDraft(pending: boolean): void {
    if (pending === this.draftPending) return;
    this.draftPending = pending;
    this.draftChars = pending ? this.submittedChars : 0;
    if (pending) this.inputHasText = true;
    this.emit('draft', pending);
  }

  /** Escreve uma tecla de controle no terminal sem contar como digitação do usuário (não atrasa a fila). */
  sendControl(data: string): void {
    this.opts.pty.write(data);
  }

  /** O agente voltou a trabalhar (ou um hook chegou): cancela a espera de agentIdle. */
  agentBusy(): void {
    clearTimeout(this.idleGraceTimer);
    this.idleGraceTimer = undefined;
  }

  async kill(): Promise<void> {
    await this.opts.pty.kill();
    await this.codexRolloutWatcher?.stop();
  }

  async unload(): Promise<void> {
    await this.opts.pty.kill();
    if (this.currentState !== 'exited') this.onExit(0);
    await this.codexRolloutWatcher?.stop();
  }

  /** Ajusta o tamanho do terminal. O ConPTY redesenha a tela inteira no tamanho novo. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.screen.resize(cols, rows);
    this.opts.pty.resize(cols, rows);
  }

  /** Espera a tela processar toda a saída já recebida (o xterm escreve de forma assíncrona). */
  settle(): Promise<void> {
    return this.screen.write('');
  }

  snapshot(): { data: string; cols: number; rows: number } {
    return { data: this.screen.serialize() + this.pendingEscape, cols: this.cols, rows: this.rows };
  }

  rename(newName: string): void {
    this.opts.log.info({ from: this.name, to: newName }, 'terminal renomeado');
    this.name = newName;
  }

  /** Saída crua do terminal (para exibir num terminal real). Devolve a função que remove o ouvinte. */
  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  private async resolveAnswer(signal: Extract<HookSignal, { kind: 'turn-end' }>): Promise<string | null> {
    if (signal.text !== null && signal.text.trim() !== '') return signal.text;
    const read = this.adapter.readTranscript?.bind(this.adapter);
    if (!signal.transcriptPath || !read) return null;
    const retries = this.opts.transcriptRetries ?? 10;
    for (let attempt = 0; attempt < retries; attempt++) {
      const text = await read(signal.transcriptPath);
      if (text !== null) return text;
      // A transcrição é gravada de forma assíncrona.
      await new Promise((resolve) => setTimeout(resolve, this.opts.transcriptRetryMs ?? 200));
    }
    return null;
  }

  private handleOutput(data: string): void {
    const turn = this.turnSeq;
    this.pendingEscape = incompleteEscapeTail(this.pendingEscape + data);
    for (const listener of this.outputListeners) listener(data);
    if (this.currentState === 'starting') this.armReady();
    if (this.owner === 'user' && this.provisionalUserTurn) this.armUserTurn();
    void this.screen.write(data).then(() => this.onScreen(turn));
  }

  private onScreen(turn: number): void {
    const { appeared, visible } = this.watcher.update(this.screen.visible(), this.screen.text());
    // O xterm processa a saída de modo assíncrono: ela pode pertencer a um turno já encerrado.
    if (turn !== this.turnSeq) return;
    this.waitingOnScreen = visible.has('waiting');
    const failure: TurnFailure | null = appeared.includes('interrupted') ? 'interrupted' : appeared.includes('failed') ? 'agent-error' : null;
    if (failure && this.owner !== null) {
      const owner = this.owner;
      this.opts.log.info({ owner, askId: this.currentAskId, failure }, 'turno terminou sem resposta');
      this.endTurn();
      this.emit('turnFailed', { owner, reason: failure });
      return;
    }
    this.refreshWaiting();
  }

  private learnAgentSession(id: string | null): void {
    if (id === null || id === this.agentSessionId) return;
    this.agentSessionId = id;
    this.codexRolloutWatcher?.setSessionId(id);
    this.emit('agentSession', id);
  }

  private onCodexRollout(event: CodexRolloutEvent): void {
    this.learnAgentSession(event.sessionId);
    if (event.kind === 'session') return;
    const completionId = `${event.sessionId}:${event.turnId}`;
    if (event.kind === 'task-started') {
      if (this.completedHooks.has(completionId)) return;
      clearTimeout(this.userTurnTimer);
      this.provisionalUserTurn = false;
      this.waitingByHook = false;
      this.waitingOnScreen = false;
      if (this.owner === null) this.startTurn('user', null);
      else if (this.currentState === 'waiting') this.setState('busy', 'rollout-task-started');
      this.codexTurnId = event.turnId;
      return;
    }
    if (this.codexTurnId !== event.turnId || this.owner === null || this.completedHooks.has(completionId)) return;
    this.rememberCompletion(completionId);
    const owner = this.owner;
    this.endTurn();
    if (event.kind === 'turn-aborted') {
      this.emit('turnFailed', { owner, reason: event.reason === 'interrupted' ? 'interrupted' : 'agent-error' });
      return;
    }
    const answer = event.answer?.trim() ? event.answer : null;
    if (owner === 'broker' && answer === null) this.emit('turnFailed', { owner, reason: 'no-answer' });
    else this.emit('turnEnded', { owner, answer: owner === 'broker' ? answer : null });
  }

  private rememberCompletion(completionId: string): void {
    this.completedHooks.add(completionId);
    if (this.completedHooks.size > 256) this.completedHooks.delete(this.completedHooks.values().next().value!);
  }

  private onExit(code: number): void {
    this.agentBusy();
    clearTimeout(this.readyTimer);
    clearTimeout(this.userTurnTimer);
    clearTimeout(this.turnWarningTimer);
    void this.codexRolloutWatcher?.stop();
    const owner = this.owner;
    this.owner = null;
    this.turnSeq++;
    this.opts.log.info({ code }, 'processo do terminal saiu');
    this.setState('exited', 'process-exit');
    if (owner) this.emit('turnFailed', { owner, reason: 'exited' });
  }

  private armReady(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.currentState !== 'starting') return;
      if (this.waitingOnScreen) return this.setState('waiting');
      this.everIdle = true;
      this.setState('idle', 'startup-quiet');
    }, this.opts.readyQuietMs ?? 1500);
  }

  private startTurn(owner: TurnOwner, askId: string | null): void {
    clearTimeout(this.readyTimer);
    clearTimeout(this.userTurnTimer);
    this.userTurnTimer = undefined;
    this.provisionalUserTurn = false;
    this.watcher.beginTurn(this.screen.text());
    this.turnSeq++;
    this.codexTurnId = null;
    this.owner = owner;
    this.currentAskId = askId;
    this.setState('busy', `turn-start:${owner}`);
    clearTimeout(this.turnWarningTimer);
    if (this.adapter.kind === 'codex' && owner === 'broker') {
      const turn = this.turnSeq;
      this.turnWarningTimer = setTimeout(() => {
        if (turn !== this.turnSeq || this.owner !== owner) return;
        this.opts.log.warn({ terminal: this.name, askId, durationMs: this.opts.codexLongTurnWarningMs ?? 120_000 }, 'Codex turn busy without completion signal');
      }, this.opts.codexLongTurnWarningMs ?? 120_000).unref();
    }
  }

  private armUserTurn(): void {
    if (this.adapter.kind === 'codex' && this.userTurnTimer) return;
    clearTimeout(this.userTurnTimer);
    this.userTurnTimer = setTimeout(() => {
      this.userTurnTimer = undefined;
      if (this.owner !== 'user' || !this.provisionalUserTurn || (this.currentState === 'waiting' && this.adapter.kind !== 'codex')) return;
      this.opts.log.debug('turno do usuário sem saída; voltando a idle');
      this.endTurn();
      this.emit('turnEnded', { owner: 'user', answer: null });
    }, this.adapter.kind === 'codex' ? 3000 : this.opts.userTurnQuietMs ?? 5000);
  }

  private endTurn(): void {
    this.agentBusy();
    clearTimeout(this.userTurnTimer);
    this.userTurnTimer = undefined;
    clearTimeout(this.turnWarningTimer);
    this.turnSeq++;
    this.codexTurnId = null;
    this.owner = null;
    this.currentAskId = null;
    this.waitingByHook = false;
    if (this.currentState === 'exited') return;
    this.everIdle = true;
    this.setState('idle', 'turn-end');
  }

  private refreshWaiting(): void {
    if (this.currentState === 'exited') return;
    const waiting = this.waitingOnScreen || this.waitingByHook;
    if (waiting) {
      if (this.currentState !== 'waiting') this.setState('waiting', this.waitingByHook ? 'permission-hook' : 'permission-screen');
      return;
    }
    if (this.currentState !== 'waiting') return;
    if (this.owner) {
      this.setState('busy', 'permission-cleared');
      if (this.provisionalUserTurn) this.armUserTurn();
      return;
    }
    if (this.everIdle) return this.setState('idle', 'permission-cleared');
    // Diálogo respondido durante a partida: espera a TUI silenciar de novo antes de aceitar teclas.
    this.setState('starting');
    this.armReady();
  }

  private setState(state: SessionState, reason = 'screen-or-hook'): void {
    if (state === this.currentState) return;
    this.opts.log.info({ terminal: this.name, from: this.currentState, to: state, reason, owner: this.owner, askId: this.currentAskId, turn: this.turnSeq }, 'estado do terminal');
    this.currentState = state;
    this.emit('state', state);
  }
}
