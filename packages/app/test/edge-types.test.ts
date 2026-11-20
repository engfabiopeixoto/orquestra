import { describe, expect, it } from 'vitest';
import { EDGE_TYPE, buildClosestEdges } from '../src/renderer/src/canvas/edge-routing';
import type { CanvasFlowNode } from '../src/renderer/src/canvas/flow-nodes';

const node = (id: string, x: number): CanvasFlowNode => ({ id, type: 'terminal', data: { name: id }, position: { x, y: 0 }, style: { width: 640, height: 400 } });

describe('tipo das arestas removíveis', () => {
  it('conversas usam o tipo removível, preservando a classe de estilo', () => {
    expect(EDGE_TYPE).toBe('removable');
    expect(buildClosestEdges([{ a: 'A', b: 'B' }], [node('A', 0), node('B', 720)])[0]).toMatchObject({ type: EDGE_TYPE, className: 'orq-edge' });
  });
});
