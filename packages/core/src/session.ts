import { EventEmitter } from 'node:events';
import { OrqError, type SessionState } from '@orquestra/shared';
import type { AgentAdapter, HookSignal, ScreenSignal } from './adapters/types.js';
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
   * Turno aberto por um Enter do usuário que não produz saída por este tempo volta a idle:
   * Enter vazio, /help ou um menu não disparam Stop. Agentes trabalhando mostram um indicador que atualiza a tela.
   */
  userTurnQuietMs?: number;
  transcriptRetries?: number;
  transcriptRetryMs?: number;
  agentSessionId?: string | null;
  unloaded?: boolean;
};

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  name: string;
  readonly adapter: AgentAdapter;
  agentSessionId: string | null = null;

  private currentState: SessionState = 'starting';
  private owner: TurnOwner | null = null;
  private everIdle = false;
  private waitingByHook = false;
  private waitingOnScreen = false;
  private userInputAt = 0;
  private readyTimer: NodeJS.Timeout | undefined;
  private userTurnTimer: NodeJS.Timeout | undefined;
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
    if (data.includes('\r') && this.currentState === 'idle') {
      this.startTurn('user', null);
      this.armUserTurn();
      return;
    }
    this.refreshWaiting();
  }

  async injectPrompt(text: string, askId: string): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new OrqError('INTERNAL', `A sessão ${this.name} não está ociosa (${this.currentState}). O broker só injeta em idle.`);
    }
    const prepared = this.adapter.preparePrompt(text, { cwd: this.opts.cwd, askId });
    this.startTurn('broker', askId);
    try {
      await writePrompt(this.opts.pty, prepared, { encode: this.adapter.encodeInput?.bind(this.adapter) });
    } catch (error) {
      this.endTurn();
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
    const turn = this.turnSeq;
    const answer = await this.resolveAnswer(signal);
    if (turn !== this.turnSeq || this.owner !== owner) {
      this.opts.log.warn({ event, turn }, 'resposta de um turno que já terminou; descartada');
      return;
    }
    this.endTurn();
    if (answer === null) this.emit('turnFailed', { owner, reason: 'no-answer' });
    else this.emit('turnEnded', { owner, answer });
  }

  async kill(): Promise<void> {
    await this.opts.pty.kill();
  }

  async unload(): Promise<void> {
    await this.opts.pty.kill();
    if (this.currentState !== 'exited') this.onExit(0);
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
    this.pendingEscape = incompleteEscapeTail(this.pendingEscape + data);
    for (const listener of this.outputListeners) listener(data);
    if (this.currentState === 'starting') this.armReady();
    if (this.owner === 'user') this.armUserTurn();
    void this.screen.write(data).then(() => this.onScreen());
  }

  private onScreen(): void {
    const { appeared, visible } = this.watcher.update(this.screen.visible(), this.screen.text());
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
    this.emit('agentSession', id);
  }

  private onExit(code: number): void {
    clearTimeout(this.readyTimer);
    clearTimeout(this.userTurnTimer);
    const owner = this.owner;
    this.owner = null;
    this.turnSeq++;
    this.opts.log.info({ code }, 'processo do terminal saiu');
    this.setState('exited');
    if (owner) this.emit('turnFailed', { owner, reason: 'exited' });
  }

  private armReady(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.currentState !== 'starting') return;
      if (this.waitingOnScreen) return this.setState('waiting');
      this.everIdle = true;
      this.setState('idle');
    }, this.opts.readyQuietMs ?? 1500);
  }

  private startTurn(owner: TurnOwner, askId: string | null): void {
    this.turnSeq++;
    this.owner = owner;
    this.currentAskId = askId;
    this.setState('busy');
  }

  private armUserTurn(): void {
    clearTimeout(this.userTurnTimer);
    this.userTurnTimer = setTimeout(() => {
      if (this.owner !== 'user' || this.currentState === 'waiting') return;
      this.opts.log.debug('turno do usuário sem saída; voltando a idle');
      this.endTurn();
      this.emit('turnEnded', { owner: 'user', answer: null });
    }, this.opts.userTurnQuietMs ?? 5000);
  }

  private endTurn(): void {
    clearTimeout(this.userTurnTimer);
    this.turnSeq++;
    this.owner = null;
    this.currentAskId = null;
    this.waitingByHook = false;
    if (this.currentState === 'exited') return;
    this.everIdle = true;
    this.setState('idle');
  }

  private refreshWaiting(): void {
    if (this.currentState === 'exited') return;
    const waiting = this.waitingOnScreen || this.waitingByHook;
    if (waiting) {
      if (this.currentState !== 'waiting') this.setState('waiting');
      return;
    }
    if (this.currentState !== 'waiting') return;
    if (this.owner) return this.setState('busy');
    if (this.everIdle) return this.setState('idle');
    // Diálogo respondido durante a partida: espera a TUI silenciar de novo antes de aceitar teclas.
    this.setState('starting');
    this.armReady();
  }

  private setState(state: SessionState): void {
    if (state === this.currentState) return;
    this.opts.log.debug({ from: this.currentState, to: state }, 'estado do terminal');
    this.currentState = state;
    this.emit('state', state);
  }
}
