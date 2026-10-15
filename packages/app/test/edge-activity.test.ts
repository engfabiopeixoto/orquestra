import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { edgeActivity, edgeId } from '../src/renderer/src/canvas/edge-activity';

const entry = (from: string, overrides: Partial<QueueEntry> = {}): QueueEntry => ({ askId: `${from}-${Math.random()}`, from, preview: 'p', status: 'queued', kind: 'prompt', ...overrides });
const edges = [{ a: 'A', b: 'B' }];

describe('edgeActivity', () => {
  it('monta o id igual ao do canvas', () => {
    expect(edgeId({ a: 'A', b: 'B' })).toBe('A--B');
  });

  it('sem fila, nenhuma aresta acende', () => {
    expect(edgeActivity(edges, {}).size).toBe(0);
    expect(edgeActivity(edges, { B: [] }).size).toBe(0);
  });

  it('pedido de A na fila de B é fluxo a→b', () => {
    expect(edgeActivity(edges, { B: [entry('A')] }).get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: false });
  });

  it('pedido de B na fila de A é fluxo b→a', () => {
    expect(edgeActivity(edges, { A: [entry('B', { kind: 'delivery', status: 'running' })] }).get('A--B')).toEqual({ flow: 'b→a', kind: 'delivery', running: true });
  });

  it('pedidos nos dois sentidos viram both', () => {
    expect(edgeActivity(edges, { A: [entry('B')], B: [entry('A')] }).get('A--B')?.flow).toBe('both');
  });

  it('o pedido em curso define o tipo, mesmo atrás de um na fila', () => {
    const activity = edgeActivity(edges, { B: [entry('A', { kind: 'prompt' }), entry('A', { kind: 'delivery', status: 'running' })] }).get('A--B');
    expect(activity).toEqual({ flow: 'a→b', kind: 'delivery', running: true });
  });

  it('sem pedido em curso, vale o primeiro da fila', () => {
    const activity = edgeActivity(edges, { B: [entry('A', { kind: 'delivery' }), entry('A', { kind: 'prompt' })] }).get('A--B');
    expect(activity).toEqual({ flow: 'a→b', kind: 'delivery', running: false });
  });

  it('fila de um terceiro terminal não acende a aresta', () => {
    expect(edgeActivity(edges, { B: [entry('C')], C: [entry('A')] }).size).toBe(0);
  });

  it('pedido entre terminais sem aresta não aparece', () => {
    expect(edgeActivity([], { B: [entry('A')] }).size).toBe(0);
  });
});
