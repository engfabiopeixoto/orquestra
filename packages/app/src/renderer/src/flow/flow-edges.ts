import { MarkerType, type Edge } from '@xyflow/react';
import type { FlowGraph } from '@orquestra/shared/flow';
import { flowCanvasId } from '@orquestra/shared/flow';
import type { TerminalView } from '../store';
import { EDGE_TYPE } from '../canvas/edge-routing';
import { AGENT_FLOW_IO } from './feature-flags';

export function dataEdges(graph: FlowGraph, terminals: Record<string, TerminalView>): Edge[] {
  const nodes = AGENT_FLOW_IO ? graph.nodes : graph.nodes.filter((node) => node.kind !== 'agent');
  const ids = new Map(nodes.map((node) => [node.id, node.kind === 'agent' ? Object.values(terminals).find((terminal) => terminal.id === node.config.terminalId)?.name : flowCanvasId(node.id)]));
  return graph.connections.flatMap((edge) => { const source = ids.get(edge.from), target = ids.get(edge.to); return source && target ? [{ id: `flow-edge:${edge.id}`, source, target, sourceHandle: `out:${edge.output}`, targetHandle: `in:${edge.input}`, type: EDGE_TYPE, className: 'data-flow-edge', markerEnd: { type: MarkerType.ArrowClosed, color: '#7aa7ff' }, data: { kind: 'flow', id: edge.id } }] : []; });
}
export function flowEndpoint(graph: FlowGraph, terminals: Record<string, TerminalView>, canvasId: string): string | null {
  if (canvasId.startsWith('flow:')) return graph.nodes.some((node) => node.id === canvasId.slice(5) && node.kind !== 'agent') ? canvasId.slice(5) : null;
  if (!AGENT_FLOW_IO) return null;
  const id = terminals[canvasId]?.id;
  return graph.nodes.find((node) => node.kind === 'agent' && node.config.terminalId === id)?.id ?? null;
}
