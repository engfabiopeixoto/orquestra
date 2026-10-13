import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultFlowNode } from '@orquestra/shared/flow';
import { EDGE_TYPE, buildClosestEdges } from '../src/renderer/src/canvas/edge-routing';
import type { CanvasFlowNode } from '../src/renderer/src/canvas/flow-nodes';
import { dataEdges } from '../src/renderer/src/flow/flow-edges';

const node = (id: string, x: number): CanvasFlowNode => ({ id, type: 'terminal', data: { name: id }, position: { x, y: 0 }, style: { width: 640, height: 400 } });

describe('tipo das arestas removíveis', () => {
  it('conversas e dados usam o mesmo tipo removível, preservando a classe de estilo', () => {
    expect(EDGE_TYPE).toBe('removable');
    expect(buildClosestEdges([{ a: 'A', b: 'B' }], [node('A', 0), node('B', 720)])[0]).toMatchObject({ type: EDGE_TYPE, className: 'orq-edge' });
    const from = defaultFlowNode('code', randomUUID()), to = defaultFlowNode('code', randomUUID());
    const graph = { nodes: [from, to], connections: [{ id: randomUUID(), from: from.id, output: 'saida', to: to.id, input: 'entrada' }], autoRun: false };
    expect(dataEdges(graph, {})[0]).toMatchObject({ type: EDGE_TYPE, className: 'data-flow-edge' });
  });
});
