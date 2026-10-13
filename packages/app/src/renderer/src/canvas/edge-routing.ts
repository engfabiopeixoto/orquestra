import type { Edge } from '@xyflow/react';
import type { CanvasFlowNode } from './flow-nodes';
import type { Rect, EdgeView } from '../store';

/** Tipo de aresta (registrado no Canvas) com o botão × de desconectar. */
export const EDGE_TYPE = 'removable';

type Side = 'left' | 'right' | 'top' | 'bottom';
function ports(rect: Rect): Array<{ side: Side; x: number; y: number }> {
  return [
    { side: 'right', x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    { side: 'left', x: rect.x, y: rect.y + rect.height / 2 },
    { side: 'bottom', x: rect.x + rect.width / 2, y: rect.y + rect.height },
    { side: 'top', x: rect.x + rect.width / 2, y: rect.y },
  ];
}

/** Choose the shortest pair of side-center ports, independently of edge creation order. */
export function nearestHandles(a: Rect, b: Rect, portalA = false, portalB = false): { sourceHandle: Side; targetHandle: Side } {
  let distance = Infinity;
  let pair: { sourceHandle: Side; targetHandle: Side } = { sourceHandle: 'right', targetHandle: 'left' };
  const sourcePorts = ports(portalA ? { ...a, height: 72 } : a).filter((port) => !portalA || port.side === 'left' || port.side === 'right');
  const targetPorts = ports(portalB ? { ...b, height: 72 } : b).filter((port) => !portalB || port.side === 'left' || port.side === 'right');
  for (const source of sourcePorts) for (const target of targetPorts) {
    const candidate = (source.x - target.x) ** 2 + (source.y - target.y) ** 2;
    if (candidate < distance) { distance = candidate; pair = { sourceHandle: source.side, targetHandle: target.side }; }
  }
  return pair;
}

export function buildClosestEdges(edges: EdgeView[], nodes: CanvasFlowNode[]): Edge[] {
  const rects = new Map<string, Rect>();
  for (const node of nodes) {
    if (node.type === 'groupFrame') continue;
    const width = node.measured?.width ?? node.width ?? Number(node.style?.width);
    const height = node.measured?.height ?? node.height ?? Number(node.style?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) rects.set(node.id, { ...node.position, width, height });
  }
  return edges.flatMap((edge) => {
    const a = rects.get(edge.a), b = rects.get(edge.b);
    return a && b ? [{ id: `${edge.a}--${edge.b}`, source: edge.a, target: edge.b, ...nearestHandles(a, b, nodes.find((node) => node.id === edge.a)?.type === 'portal', nodes.find((node) => node.id === edge.b)?.type === 'portal'), type: EDGE_TYPE, className: 'orq-edge' }] : [];
  });
}
