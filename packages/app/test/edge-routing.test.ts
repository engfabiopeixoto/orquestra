import { describe, expect, it } from 'vitest';
import { nearestHandles, buildClosestEdges, edgeClassName } from '../src/renderer/src/canvas/edge-routing';
import type { CanvasFlowNode } from '../src/renderer/src/canvas/flow-nodes';

const rect = { x: 0, y: 0, width: 640, height: 400 };
const node = (id: string, x: number, y = 0): CanvasFlowNode => ({ id, type: 'terminal', data: { name: id }, position: { x, y }, style: { width: 640, height: 400 } });
describe('conectores pelo lado mais próximo', () => {
  it('liga direita à esquerda e inverte os lados quando o destino está atrás', () => {
    expect(nearestHandles(rect, { ...rect, x: 720 })).toEqual({ sourceHandle: 'right', targetHandle: 'left' });
    expect(nearestHandles({ ...rect, x: 720 }, rect)).toEqual({ sourceHandle: 'left', targetHandle: 'right' });
  });
  it('usa baixo e cima quando os elementos estão empilhados', () => {
    expect(nearestHandles(rect, { ...rect, y: 500 })).toEqual({ sourceHandle: 'bottom', targetHandle: 'top' });
    expect(nearestHandles({ ...rect, y: 500 }, rect)).toEqual({ sourceHandle: 'top', targetHandle: 'bottom' });
  });
  it('considera tamanhos diferentes e o menor par na diagonal', () => {
    expect(nearestHandles(rect, { x: 300, y: 450, width: 320, height: 240 })).toEqual({ sourceHandle: 'bottom', targetHandle: 'top' });
    expect(nearestHandles(rect, { ...rect, x: 720, y: 500 })).toEqual({ sourceHandle: 'right', targetHandle: 'top' });
  });
  it('recalcula a mesma conexão com posições e dimensões vivas durante os gestos', () => {
    const connection = [{ a: 'A', b: 'B' }];
    expect(buildClosestEdges(connection, [node('A', 0), node('B', 720)])[0]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' });
    expect(buildClosestEdges(connection, [node('A', 800), node('B', 0)])[0]).toMatchObject({ sourceHandle: 'left', targetHandle: 'right' });
    const resized = { ...node('A', 0), measured: { width: 1500, height: 400 } };
    expect(buildClosestEdges(connection, [resized, node('B', 1600)])[0]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' });
    expect(buildClosestEdges(connection, [node('A', 0)])).toEqual([]);
  });
});

describe('atividade nas conexões', () => {
  const connection = [{ a: 'A', b: 'B' }];
  const nodes = [node('A', 0), node('B', 720)];

  it('aresta sem atividade fica só com a classe base e sem dados', () => {
    expect(buildClosestEdges(connection, nodes)[0]).toMatchObject({ className: 'orq-edge', data: undefined });
  });

  it('marca ativa, em curso e o sentido inverso', () => {
    const activity = new Map([['A--B', { flow: 'b→a' as const, kind: 'delivery' as const, running: true }]]);
    const edge = buildClosestEdges(connection, nodes, activity)[0]!;
    expect(edge.className).toBe('orq-edge orq-edge--active orq-edge--running orq-edge--reverse');
    expect(edge.data).toEqual({ activity: activity.get('A--B') });
  });

  it('nos dois sentidos não marca inverso', () => {
    expect(edgeClassName({ flow: 'both', kind: 'prompt', running: true })).toBe('orq-edge orq-edge--active orq-edge--running orq-edge--both');
    expect(edgeClassName({ flow: 'a→b', kind: 'prompt', running: false })).toBe('orq-edge orq-edge--active');
  });

  it('atividade de uma aresta que já não existe é ignorada', () => {
    const activity = new Map([['A--C', { flow: 'a→b' as const, kind: 'prompt' as const, running: true }]]);
    expect(buildClosestEdges(connection, nodes, activity).map((edge) => edge.className)).toEqual(['orq-edge']);
  });
});

