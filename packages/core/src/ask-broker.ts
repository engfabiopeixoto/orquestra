import { randomUUID } from 'node:crypto';
import { OrqError, type QueueEntry, type SessionState } from '@orquestra/shared';
import { backgroundJobError, type BackgroundJob } from './background-job.js';
import type { Logger } from './log.js';

export interface BrokerTarget {
  readonly name: string;
  readonly state: SessionState;
  readonly lastUserInputAt: number;
  /** Shell não recebe prompts: nunca digitamos texto de agente nele (viraria comando). */
  readonly acceptsPrompts: boolean;
  /** Conversa do Claude mantida em segundo plano pelo daemon: sem hooks nem pipe, não dá para entregar. */
  readonly backgroundJob?: BackgroundJob | null;
  injectPrompt(text: string, askId: string): Promise<void>;
}

export type AskOutcome = { status: 'answered'; askId: string; answer: string } | { status: 'pending'; askId: string };

export type AskStatus =
  | { status: 'queued' }
  | { status: 'running' }
  | { status: 'answered'; answer: string }
  | { status: 'failed'; reason: string };

type Waiter = { resolve: (outcome: AskOutcome) => void; reject: (error: OrqError) => void; timer: NodeJS.Timeout; detach?: () => void };

type Item = {
  askId: string;
  kind: 'prompt' | 'delivery';
  asker: string;
  target: string;
  text: string;
  status: AskStatus;
  waiter?: Waiter;
};

export type BrokerOptions = {
  resolveTarget: (name: string) => BrokerTarget | undefined;
  log: Logger;
  typingGuardMs?: number;
  newId?: () => string;
  /** Avisada a cada mudança na fila de um destino (entrada, início, fim, cancelamento). */
  onQueueChange?: (target: string) => void;
};

export class AskBroker {
  private readonly queues = new Map<string, Item[]>();
  private readonly inFlight = new Map<string, Item>();
  private readonly items = new Map<string, Item>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly blockedReasons = new Map<string, string>();
  private readonly typingGuardMs: number;
  private readonly newId: () => string;

  constructor(private readonly opts: BrokerOptions) {
    this.typingGuardMs = opts.typingGuardMs ?? 3000;
    this.newId = opts.newId ?? randomUUID;
  }

  async submit(input: { asker: string; target: string; text: string; timeoutMs: number; signal?: AbortSignal }): Promise<AskOutcome> {
    if (input.asker === input.target) {
      throw new OrqError('USAGE', 'Não dá para enviar um prompt para você mesmo. Escolha outro destino.');
    }
    const target = this.opts.resolveTarget(input.target);
    if (!target) throw new OrqError('NOT_FOUND', `Terminal ${input.target} não existe. Veja os conectados com orq peers.`);
    if (!target.acceptsPrompts) throw new OrqError('UNSUPPORTED', `${input.target} é um shell e não recebe prompts.`);
    if (target.state === 'exited') {
      throw new OrqError('PROMPT_FAILED', `${input.target} está encerrado. Reinicie o terminal e tente de novo.`);
    }
    if (target.backgroundJob) throw new OrqError('PROMPT_FAILED', backgroundJobError(input.target, target.backgroundJob));
    // Quem pergunta está atendendo um pedido do próprio destino: o destino só fica livre quando este responder.
    if (this.closesCycle(input.asker, input.target)) {
      throw new OrqError(
        'USAGE',
        `${input.target} está esperando a sua resposta e não pode atender agora. Responda primeiro e pergunte depois.`,
      );
    }
    const item: Item = { askId: this.newId(), kind: 'prompt', asker: input.asker, target: input.target, text: input.text, status: { status: 'queued' } };
    this.items.set(item.askId, item);
    const outcome = new Promise<AskOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!item.waiter) return;
        item.waiter.detach?.();
        item.waiter = undefined;
        this.opts.log.info({ askId: item.askId, target: item.target }, 'prazo do pedido esgotado; resposta será entregue depois');
        resolve({ status: 'pending', askId: item.askId });
      }, input.timeoutMs);
      item.waiter = { resolve, reject, timer };
      // Quem perguntou desconectou (o orq foi morto): ninguém lê mais a resposta direta; ela vai para o terminal dele.
      const disconnect = () => {
        if (!item.waiter) return;
        clearTimeout(item.waiter.timer);
        item.waiter.detach?.();
        item.waiter = undefined;
        this.opts.log.info({ askId: item.askId, target: item.target }, 'quem perguntou desconectou; resposta será entregue depois');
        resolve({ status: 'pending', askId: item.askId });
      };
      item.waiter.detach = () => input.signal?.removeEventListener('abort', disconnect);
      if (input.signal?.aborted) disconnect();
      else input.signal?.addEventListener('abort', disconnect, { once: true });
    });
    this.opts.log.info({ askId: item.askId, asker: input.asker, target: input.target }, 'pedido recebido');
    this.enqueue(item);
    return outcome;
  }

  status(askId: string): AskStatus | undefined {
    return this.items.get(askId)?.status;
  }

  queued(target: string): number {
    return (this.queues.get(target)?.length ?? 0) + (this.inFlight.has(target) ? 1 : 0);
  }

  cancel(askId: string): boolean {
    const item = this.items.get(askId);
    if (!item || (item.status.status !== 'queued' && item.status.status !== 'running')) return false;
    const queue = this.queues.get(item.target) ?? [];
    const index = queue.indexOf(item);
    if (index >= 0) {
      queue.splice(index, 1);
      this.notify(item.target, 'cancelled');
    }
    // Em curso: o agente segue até o fim; o fim do turno libera a fila (não injetamos com ele ocupado).
    this.fail(item, 'cancelado');
    return true;
  }

  /**
   * O terminal que perguntou trocou de nome: respostas atrasadas e a regra de ciclo usam o nome atual.
   * Pedidos em que ele é o destino não existem aqui (renomear exige a fila dele vazia).
   */
  renameAsker(oldName: string, newName: string): void {
    for (const item of this.items.values()) if (item.asker === oldName) item.asker = newName;
    const queue = this.queues.get(oldName);
    if (queue && queue.length === 0) this.queues.delete(oldName);
  }

  sessionChanged(name: string): void {
    if (this.opts.resolveTarget(name)?.state === 'exited') return this.failQueue(name, 'o terminal foi encerrado');
    this.pump(name);
  }

  /** O job em segundo plano do terminal apareceu ou sumiu: o que está na fila não tem como ser entregue. */
  backgroundJobChanged(name: string): void {
    this.pump(name);
  }

  turnEnded(name: string, answer: string): void {
    const item = this.inFlight.get(name);
    if (!item) return;
    this.inFlight.delete(name);
    this.notify(name, 'turn-ended');
    if (item.kind === 'prompt' && item.status.status === 'running') this.succeed(item, answer);
    this.pump(name);
  }

  turnFailed(name: string, reason: string): void {
    const item = this.inFlight.get(name);
    if (!item) return;
    this.inFlight.delete(name);
    this.notify(name, 'turn-failed');
    if (item.kind === 'prompt' && item.status.status === 'running') this.fail(item, reason);
    this.pump(name);
  }

  /** Entrega um texto ao terminal sem esperar resposta (função, guia do regente). */
  brief(target: string, from: string, text: string): string {
    const session = this.opts.resolveTarget(target);
    if (!session) throw new OrqError('NOT_FOUND', `Terminal ${target} não existe.`);
    if (!session.acceptsPrompts) throw new OrqError('UNSUPPORTED', `${target} é um shell e não recebe prompts.`);
    if (session.state === 'exited') throw new OrqError('PROMPT_FAILED', `${target} está encerrado. Reinicie o terminal.`);
    if (session.backgroundJob) throw new OrqError('PROMPT_FAILED', backgroundJobError(target, session.backgroundJob));
    const item: Item = { askId: this.newId(), kind: 'delivery', asker: from, target, text, status: { status: 'queued' } };
    this.items.set(item.askId, item);
    this.opts.log.info({ askId: item.askId, from, target }, 'entrega enfileirada');
    this.enqueue(item);
    return item.askId;
  }

  sessionRemoved(name: string, reason = `${name} foi removido`): void {
    this.failQueue(name, reason);
  }

  /** Pedido em curso primeiro, depois a fila, na ordem de atendimento. */
  list(target: string): QueueEntry[] {
    const running = this.inFlight.get(target);
    const items = [...(running ? [running] : []), ...(this.queues.get(target) ?? [])];
    return items.map((item) => ({
      askId: item.askId,
      from: item.asker,
      preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 80),
      status: item === running ? 'running' : 'queued',
      kind: item.kind,
    }));
  }

  private notify(target: string, reason: string): void {
    this.opts.log.info({ terminal: target, reason, state: this.opts.resolveTarget(target)?.state, queued: this.queues.get(target)?.length ?? 0, askId: this.inFlight.get(target)?.askId ?? null }, 'fila atualizada');
    this.opts.onQueueChange?.(target);
  }

  /** Segue dependências ativas, inclusive pedidos que ainda esperam na fila. */
  private closesCycle(asker: string, target: string): boolean {
    const pending = [target];
    const visited = new Set<string>();
    const active = [...this.inFlight.values(), ...[...this.queues.values()].flat()];
    while (pending.length) {
      const name = pending.pop()!;
      if (name === asker) return true;
      if (visited.has(name)) continue;
      visited.add(name);
      for (const item of active) if (item.kind === 'prompt' && item.asker === name && item.status.status !== 'failed') pending.push(item.target);
    }
    return false;
  }

  private failQueue(name: string, reason: string): void {
    clearTimeout(this.retryTimers.get(name));
    this.retryTimers.delete(name);
    this.blockedReasons.delete(name);
    const pending = [...(this.inFlight.has(name) ? [this.inFlight.get(name)!] : []), ...(this.queues.get(name) ?? [])];
    this.inFlight.delete(name);
    this.queues.delete(name);
    if (pending.length > 0) this.notify(name, reason);
    for (const item of pending) {
      if (item.kind === 'prompt' && (item.status.status === 'queued' || item.status.status === 'running')) {
        this.fail(item, reason);
      }
    }
  }

  private enqueue(item: Item): void {
    const queue = this.queues.get(item.target) ?? [];
    queue.push(item);
    this.queues.set(item.target, queue);
    this.notify(item.target, 'enqueued');
    this.pump(item.target);
  }

  private pump(name: string): void {
    if (this.inFlight.has(name)) { this.blocked(name, 'in-flight'); return; }
    const queue = this.queues.get(name);
    if (!queue || queue.length === 0) {
      clearTimeout(this.retryTimers.get(name));
      this.retryTimers.delete(name);
      this.blockedReasons.delete(name);
      return;
    }
    const target = this.opts.resolveTarget(name);
    if (!target || target.state === 'exited') return this.failQueue(name, 'o terminal foi encerrado');
    if (target.backgroundJob) return this.failQueue(name, `a conversa está em segundo plano; rode \`claude stop ${target.backgroundJob.id8}\` e reinicie o terminal`);
    if (target.state !== 'idle') {
      this.blocked(name, target.state);
      // Recupera uma notificação de idle perdida; nunca força o fim de um turno.
      this.retryLater(name, 1000);
      return;
    }
    const sinceTyping = Date.now() - target.lastUserInputAt;
    if (sinceTyping < this.typingGuardMs) {
      this.blocked(name, 'user-typing');
      this.retryLater(name, this.typingGuardMs - sinceTyping);
      return;
    }
    const item = queue.shift()!;
    this.blockedReasons.delete(name);
    clearTimeout(this.retryTimers.get(name));
    this.retryTimers.delete(name);
    this.inFlight.set(name, item);
    if (item.kind === 'prompt') item.status = { status: 'running' };
    this.notify(name, 'injecting');
    this.opts.log.info({ askId: item.askId, target: name, kind: item.kind }, 'injetando no terminal');
    target.injectPrompt(item.text, item.askId).catch((error: unknown) => {
      this.opts.log.error({ askId: item.askId, err: error }, 'falha ao digitar no terminal');
      // O PTY antigo pode rejeitar depois de remover/recarregar ou de terminar o turno.
      if (this.inFlight.get(name) !== item) return;
      this.inFlight.delete(name);
      this.notify(name, 'injection-failed');
      if (item.kind === 'prompt' && item.status.status === 'running') this.fail(item, 'falha ao digitar no terminal');
      this.pump(name);
    });
  }

  private blocked(name: string, reason: string): void {
    if (this.blockedReasons.get(name) === reason) return;
    this.blockedReasons.set(name, reason);
    this.opts.log.info({ terminal: name, reason, queued: this.queues.get(name)?.length ?? 0, askId: this.inFlight.get(name)?.askId ?? null }, 'entrega bloqueada');
  }

  private retryLater(name: string, ms: number): void {
    if (this.retryTimers.has(name)) return;
    this.retryTimers.set(
      name,
      setTimeout(() => {
        this.retryTimers.delete(name);
        this.pump(name);
      }, ms).unref(),
    );
  }

  private succeed(item: Item, answer: string): void {
    item.status = { status: 'answered', answer };
    this.opts.log.info({ askId: item.askId, target: item.target }, 'pedido respondido');
    if (item.waiter) {
      clearTimeout(item.waiter.timer);
      item.waiter.detach?.();
      item.waiter.resolve({ status: 'answered', askId: item.askId, answer });
      item.waiter = undefined;
      return;
    }
    this.deliver(item, `[orq] Resposta de ${item.target} ao pedido ${item.askId}:\n${answer}`);
  }

  private fail(item: Item, reason: string): void {
    item.status = { status: 'failed', reason };
    this.opts.log.info({ askId: item.askId, target: item.target, reason }, 'pedido falhou');
    if (item.waiter) {
      clearTimeout(item.waiter.timer);
      item.waiter.detach?.();
      item.waiter.reject(new OrqError('PROMPT_FAILED', `O pedido para ${item.target} falhou: ${reason}.`));
      item.waiter = undefined;
      return;
    }
    this.deliver(item, `[orq] O pedido ${item.askId} para ${item.target} falhou: ${reason}.`);
  }

  private deliver(source: Item, text: string): void {
    const asker = this.opts.resolveTarget(source.asker);
    // Shell não recebe prompts: o texto viraria comando. O resultado fica em orq result.
    if (!asker || !asker.acceptsPrompts || asker.state === 'exited') return;
    this.enqueue({ askId: this.newId(), kind: 'delivery', asker: source.target, target: source.asker, text, status: { status: 'queued' } });
  }
}
