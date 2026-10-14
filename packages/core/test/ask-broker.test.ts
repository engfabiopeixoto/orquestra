import type { SessionState } from '@orquestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskBroker, type BrokerTarget } from '../src/ask-broker.js';
import { silentLogger } from '../src/log.js';

class Target implements BrokerTarget {
  state: SessionState = 'idle';
  lastUserInputAt = 0;
  acceptsPrompts = true;
  failNext = false;
  readonly injected: Array<{ text: string; askId: string }> = [];
  constructor(readonly name: string) {}
  async injectPrompt(text: string, askId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('falha ao digitar');
    }
    this.injected.push({ text, askId });
    this.state = 'busy';
  }
}

function setup(guardMs = 0) {
  const targets = new Map<string, Target>();
  for (const name of ['A', 'B', 'C']) targets.set(name, new Target(name));
  let counter = 0;
  const changes: string[] = [];
  const broker = new AskBroker({
    resolveTarget: (name) => targets.get(name),
    log: silentLogger(),
    typingGuardMs: guardMs,
    newId: () => `id${++counter}`,
    onQueueChange: (target) => changes.push(target),
  });
  const finish = (name: string, answer: string) => {
    targets.get(name)!.state = 'idle';
    broker.turnEnded(name, answer);
  };
  return { broker, targets, finish, changes, t: (name: string) => targets.get(name)! };
}

describe('AskBroker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reavalia fila pendente se a notificação de idle não chegou, sem injetar em busy', async () => {
    const { broker, t } = setup();
    t('B').state = 'busy';
    void broker.submit({ asker: 'A', target: 'B', text: 'pedido', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t('B').injected).toHaveLength(0);
    t('B').state = 'idle';
    await vi.advanceTimersByTimeAsync(1000);
    expect(t('B').injected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t('B').injected).toHaveLength(1);
  });

  it('rejeição atrasada da injeção antiga não apaga o pedido novo após recarregar', async () => {
    const { broker, t, finish } = setup();
    let reject!: (error: Error) => void;
    t('B').injectPrompt = () => new Promise<void>((_resolve, fail) => { reject = fail; });
    const old = broker.submit({ asker: 'A', target: 'B', text: 'antigo', timeoutMs: 60_000 });
    const failed = expect(old).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
    broker.sessionRemoved('B');
    await failed;
    t('B').injectPrompt = Target.prototype.injectPrompt;
    const next = broker.submit({ asker: 'C', target: 'B', text: 'novo', timeoutMs: 60_000 });
    reject(new Error('PTY antigo encerrado'));
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.list('B')).toMatchObject([{ askId: 'id2', status: 'running' }]);
    finish('B', 'resposta nova');
    await expect(next).resolves.toMatchObject({ answer: 'resposta nova' });
    expect(broker.status('id1')).toMatchObject({ status: 'failed', reason: 'B foi removido' });
  });

  it('recusa ciclo de espera com três remetentes', async () => {
    const { broker } = setup();
    void broker.submit({ asker: 'A', target: 'B', text: '1', timeoutMs: 60_000 });
    void broker.submit({ asker: 'B', target: 'C', text: '2', timeoutMs: 60_000 });
    const cycle = broker.submit({ asker: 'C', target: 'A', text: '3', timeoutMs: 10 });
    const rejected = expect(cycle).rejects.toMatchObject({ code: 'USAGE' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
  });

  it('signal já abortado devolve pending imediatamente', async () => {
    const { broker } = setup();
    const controller = new AbortController(); controller.abort();
    const outcome = vi.fn();
    void broker.submit({ asker: 'A', target: 'B', text: 'pedido', timeoutMs: 60_000, signal: controller.signal }).then(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toHaveBeenCalledWith({ status: 'pending', askId: 'id1' });
  });

  it('brief para terminal encerrado não cria fila impossível de entregar', () => {
    const { broker, t } = setup();
    t('B').state = 'exited';
    expect(() => broker.brief('B', 'A', 'papel')).toThrow();
    expect(broker.queued('B')).toBe(0);
  });

  it('lista a fila do destino e avisa cada mudança', async () => {
    const { broker, changes, finish } = setup();
    void broker.submit({ asker: 'A', target: 'B', text: 'primeiro pedido', timeoutMs: 60_000 });
    void broker.submit({ asker: 'C', target: 'B', text: 'segundo', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.list('B')).toEqual([
      { askId: 'id1', from: 'A', preview: 'primeiro pedido', status: 'running', kind: 'prompt' },
      { askId: 'id2', from: 'C', preview: 'segundo', status: 'queued', kind: 'prompt' },
    ]);
    finish('B', 'ok');
    expect(changes.filter((target) => target === 'B').length).toBeGreaterThanOrEqual(3);
  });

  it('quem perguntou foi renomeado: a resposta atrasada chega no nome novo', async () => {
    const { broker, targets, finish, t } = setup();
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'longo', timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toMatchObject({ status: 'pending' });
    targets.set('A2', new Target('A2'));
    targets.delete('A');
    broker.renameAsker('A', 'A2');
    finish('B', 'pronto');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('A2').injected.map((item) => item.text)).toEqual([expect.stringContaining('pronto')]);
  });

  it('depois de uma falha ao digitar, segue para o próximo pedido da fila', async () => {
    const { broker, t } = setup();
    t('B').failNext = true;
    const first = broker.submit({ asker: 'A', target: 'B', text: '1', timeoutMs: 60_000 });
    void broker.submit({ asker: 'C', target: 'B', text: '2', timeoutMs: 60_000 });
    await expect(first).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected.map((item) => item.text)).toEqual(['2']);
  });

  it('injeta no alvo ocioso e resolve com a resposta', async () => {
    const { broker, finish, t } = setup();
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'oi', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected).toEqual([{ text: 'oi', askId: 'id1' }]);
    finish('B', 'olá');
    await expect(outcome).resolves.toEqual({ status: 'answered', askId: 'id1', answer: 'olá' });
  });

  it('recusa prompt para si mesmo', async () => {
    const { broker } = setup();
    await expect(broker.submit({ asker: 'A', target: 'A', text: 'x', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('atende dois pedidos ao mesmo destino em ordem', async () => {
    const { broker, finish, t } = setup();
    const fromA = broker.submit({ asker: 'A', target: 'B', text: 'de A', timeoutMs: 60_000 });
    const fromC = broker.submit({ asker: 'C', target: 'B', text: 'de C', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected.map((item) => item.text)).toEqual(['de A']);
    expect(broker.queued('B')).toBe(2);
    finish('B', 'resposta A');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected.map((item) => item.text)).toEqual(['de A', 'de C']);
    finish('B', 'resposta C');
    await expect(fromA).resolves.toMatchObject({ answer: 'resposta A' });
    await expect(fromC).resolves.toMatchObject({ answer: 'resposta C' });
  });

  it('espera o alvo ficar idle antes de injetar', async () => {
    const { broker, t } = setup();
    t('B').state = 'busy';
    void broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected).toEqual([]);
    t('B').state = 'idle';
    broker.sessionChanged('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected).toHaveLength(1);
  });

  it('espera o usuário parar de digitar', async () => {
    const { broker, t } = setup(3000);
    t('B').lastUserInputAt = Date.now();
    void broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t('B').injected).toEqual([]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t('B').injected).toHaveLength(1);
  });

  it('depois do prazo devolve pendente e entrega a resposta no terminal de quem perguntou', async () => {
    const { broker, finish, t } = setup();
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'longo', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toEqual({ status: 'pending', askId: 'id1' });
    expect(broker.status('id1')).toEqual({ status: 'running' });
    finish('B', 'resposta tardia');
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.status('id1')).toEqual({ status: 'answered', answer: 'resposta tardia' });
    expect(t('A').injected[0]!.text).toBe('[orq] Resposta de B ao pedido id1:\nresposta tardia');
  });

  it('não injeta o próximo prompt enquanto o turno que estourou o prazo não termina', async () => {
    const { broker, finish, t } = setup();
    void broker.submit({ asker: 'A', target: 'B', text: 'primeiro', timeoutMs: 1000 });
    void broker.submit({ asker: 'C', target: 'B', text: 'segundo', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5000);
    t('B').state = 'idle';
    broker.sessionChanged('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected.map((item) => item.text)).toEqual(['primeiro']);
    finish('B', 'tarde');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('B').injected.map((item) => item.text)).toEqual(['primeiro', 'segundo']);
  });

  it('falha do turno antes do prazo rejeita com PROMPT_FAILED', async () => {
    const { broker, t } = setup();
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    t('B').state = 'idle';
    broker.turnFailed('B', 'o turno foi interrompido');
    await expect(outcome).rejects.toMatchObject({ code: 'PROMPT_FAILED', message: expect.stringMatching(/interrompido/) });
  });

  it('falha depois do prazo é avisada no terminal de quem perguntou', async () => {
    const { broker, t } = setup();
    void broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    t('B').state = 'idle';
    broker.turnFailed('B', 'o terminal foi encerrado');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('A').injected[0]!.text).toBe('[orq] O pedido id1 para B falhou: o terminal foi encerrado.');
  });

  it('remover o alvo falha o pedido em curso e os da fila', async () => {
    const { broker } = setup();
    const running = broker.submit({ asker: 'A', target: 'B', text: '1', timeoutMs: 60_000 });
    const queued = broker.submit({ asker: 'C', target: 'B', text: '2', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    broker.sessionRemoved('B');
    await expect(running).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
    await expect(queued).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
  });

  it('cancelar um pedido na fila rejeita quem perguntou', async () => {
    const { broker, t } = setup();
    t('B').state = 'busy';
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    expect(broker.cancel('id1')).toBe(true);
    await expect(outcome).rejects.toMatchObject({ message: expect.stringMatching(/cancelado/) });
  });

  it('quando quem perguntou desconecta, a resposta é entregue depois no terminal dele', async () => {
    const { broker, finish, t } = setup();
    const abort = new AbortController();
    const outcome = broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000, signal: abort.signal });
    void outcome.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    finish('B', 'resposta');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('A').injected[0]!.text).toBe('[orq] Resposta de B ao pedido id1:\nresposta');
  });

  it('não digita a resposta tardia num terminal que não recebe prompts (shell)', async () => {
    const { broker, finish, t } = setup();
    t('A').acceptsPrompts = false;
    void broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    finish('B', 'Remove-Item -Recurse C:\\');
    await vi.advanceTimersByTimeAsync(0);
    expect(t('A').injected).toEqual([]);
    expect(broker.status('id1')).toEqual({ status: 'answered', answer: 'Remove-Item -Recurse C:\\' });
  });

  it('destino que encerra falha também os pedidos que estavam na fila', async () => {
    const { broker, t } = setup();
    const running = broker.submit({ asker: 'A', target: 'B', text: '1', timeoutMs: 60_000 });
    const queued = broker.submit({ asker: 'C', target: 'B', text: '2', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    t('B').state = 'exited';
    broker.turnFailed('B', 'o terminal foi encerrado');
    broker.sessionChanged('B');
    await expect(running).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
    await expect(queued).rejects.toMatchObject({ code: 'PROMPT_FAILED', message: expect.stringMatching(/encerrado/) });
  });

  it('recusa na hora o pedido de volta para quem está esperando a sua resposta', async () => {
    const { broker } = setup();
    void broker.submit({ asker: 'A', target: 'B', text: 'pergunta', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(broker.submit({ asker: 'B', target: 'A', text: 'esclarecimento', timeoutMs: 60_000 })).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringMatching(/esperando a sua resposta/),
    });
  });

  it('destino inexistente é NOT_FOUND e encerrado é PROMPT_FAILED', async () => {
    const { broker, t } = setup();
    await expect(broker.submit({ asker: 'A', target: 'Z', text: 'x', timeoutMs: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    t('B').state = 'exited';
    await expect(broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 1 })).rejects.toMatchObject({ code: 'PROMPT_FAILED' });
  });

  it('brief entrega o texto sem esperar resposta e libera a fila no fim do turno', () => {
    const { broker, t, finish } = setup();
    t('B').state = 'busy';
    const askId = broker.brief('B', 'A', '[orq] Sua função: x\ny');
    expect(broker.list('B')).toEqual([{ askId, from: 'A', preview: '[orq] Sua função: x y', status: 'queued', kind: 'delivery' }]);
    t('B').state = 'idle';
    broker.sessionChanged('B');
    expect(t('B').injected).toEqual([{ text: '[orq] Sua função: x\ny', askId }]);
    finish('B', 'entendido');
    expect(broker.list('B')).toEqual([]);
  });

  it('sessionRemoved com motivo falha os pedidos com esse motivo', async () => {
    const { broker } = setup();
    const pending = broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    broker.sessionRemoved('B', 'removido por R');
    await expect(pending).rejects.toThrow(/removido por R/);
  });
});
