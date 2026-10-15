// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINGER_MS, useEdgeActivity } from '../src/renderer/src/canvas/use-edge-activity';
import type { EdgeView } from '../src/renderer/src/store';

const edges: EdgeView[] = [{ a: 'A', b: 'B' }];
const running: Record<string, QueueEntry[]> = { B: [{ askId: '1', from: 'A', preview: 'p', status: 'running', kind: 'prompt' }] };
type Answer = { askId: string; from: string; target: string; at: number };
type Props = { queues: Record<string, QueueEntry[]>; scope: string; answers?: Answer[] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (initial: Props) => renderHook((props: Props) => useEdgeActivity(edges, props.queues, props.scope, props.answers), { initialProps: initial });

describe('useEdgeActivity', () => {
  it('mantém a atividade sem "em curso" por 3 s depois que a fila esvazia', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: true });
    rerender({ queues: {}, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: false });
    act(() => vi.advanceTimersByTime(LINGER_MS - 1));
    expect(result.current.has('A--B')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.has('A--B')).toBe(false);
  });

  it('pedido novo durante o atraso cancela o apagar', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w1' });
    act(() => vi.advanceTimersByTime(1000));
    rerender({ queues: running, scope: 'w1' });
    act(() => vi.advanceTimersByTime(LINGER_MS * 2));
    expect(result.current.get('A--B')?.running).toBe(true);
  });

  it('trocar de workspace descarta o que estava no atraso', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w2' });
    expect(result.current.has('A--B')).toBe(false);
    act(() => vi.advanceTimersByTime(LINGER_MS));
    expect(result.current.size).toBe(0);
  });

  it('desmontar limpa os timers', () => {
    const { rerender, unmount } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w1' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mostra a resposta por 3 s no sentido do alvo para quem perguntou', () => {
    const answers = [{ askId: 'r1', from: 'A', target: 'B', at: Date.now() }];
    const { result, rerender } = setup({ queues: {}, answers, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'b→a', kind: 'reply', running: false });
    rerender({ queues: {}, answers: [{ askId: 'r2', from: 'B', target: 'A', at: Date.now() }], scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'reply', running: false });
  });

  it('remove resposta após 3 s e dá prioridade à atividade viva da fila', () => {
    const answers = [{ askId: 'r1', from: 'A', target: 'B', at: Date.now() }];
    const { result, rerender } = setup({ queues: running, answers, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: true });
    rerender({ queues: {}, answers, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'b→a', kind: 'reply', running: false });
    act(() => vi.advanceTimersByTime(LINGER_MS));
    expect(result.current.has('A--B')).toBe(false);
  });
});
