import type { SessionState } from '@orquestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskBroker, type BrokerTarget } from '../src/ask-broker.js';
import { silentLogger } from '../src/log.js';

class Target implements BrokerTarget {
  state: SessionState = 'idle';
  lastUserInputAt = 0;
  acceptsPrompts = true;
  hasDraft = false;
  readonly injected: string[] = [];
  constructor(readonly name: string) {}
  async injectPrompt(text: string): Promise<void> {
    this.injected.push(text);
    this.state = 'busy';
  }
}

function setup() {
  const target = new Target('W');
  const blocked: string[] = [];
  const broker = new AskBroker({
    resolveTarget: (name) => (name === 'W' ? target : undefined),
    log: silentLogger(),
    typingGuardMs: 0,
    onDraftBlocked: (name) => blocked.push(name),
  });
  return { broker, target, blocked };
}

describe('AskBroker com rascunho do usuário na caixa de entrada', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('não injeta enquanto há rascunho, avisa uma vez e entrega quando ele some', async () => {
    const { broker, target, blocked } = setup();
    target.hasDraft = true;
    const outcome = broker.submit({ asker: 'A', target: 'W', text: 'pedido', timeoutMs: 60_000 });
    broker.sessionChanged('W');
    await vi.advanceTimersByTimeAsync(3000);
    expect(target.injected).toEqual([]);
    expect(broker.queued('W')).toBe(1);
    expect(blocked).toEqual(['W']);
    target.hasDraft = false;
    broker.sessionChanged('W');
    expect(target.injected).toEqual(['pedido']);
    void outcome.catch(() => {});
  });

  it('também segura entregas de função (brief)', async () => {
    const { broker, target } = setup();
    target.hasDraft = true;
    broker.brief('W', 'A', 'função');
    await vi.advanceTimersByTimeAsync(2000);
    expect(target.injected).toEqual([]);
    target.hasDraft = false;
    broker.sessionChanged('W');
    expect(target.injected).toEqual(['função']);
  });

  it('sem rascunho, nada muda', async () => {
    const { broker, target, blocked } = setup();
    void broker.submit({ asker: 'A', target: 'W', text: 'pedido', timeoutMs: 60_000 }).catch(() => {});
    expect(target.injected).toEqual(['pedido']);
    expect(blocked).toEqual([]);
  });
});
