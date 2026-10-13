import type { CanvasGroup, Position, Size } from '@orquestra/shared/workspace';
import { groupNodeId } from '@orquestra/shared/group-layout';
import type { Node } from '@xyflow/react';
import type { NoteView, TerminalView } from '../store';
import { flowCanvasId, type FlowGraph } from '@orquestra/shared/flow';
import type { PortalState } from '../../../shared/portal-protocol';

export type TerminalFlowNode = Node<{ name: string }, 'terminal'>;
export type NoteFlowNode = Node<{ name: string }, 'note'>;
export type GroupFlowNode = Node<{ groupId: string; dropTarget?: boolean }, 'groupFrame'>;
export type DataFlowNode = Node<{ flowId: string }, 'dataFlow'>;
export type PortalFlowNode = Node<{ name: string; initialUrl?: string }, 'portal'>;
export type CanvasFlowNode = TerminalFlowNode | NoteFlowNode | GroupFlowNode | DataFlowNode | PortalFlowNode;

export function buildFlowNodes(
  terminals: Record<string, TerminalView>,
  notes: Record<string, NoteView>,
  previous: CanvasFlowNode[] = [],
  groups: CanvasGroup[] = [],
  flow?: FlowGraph,
  portals: Record<string, PortalState> = {},
): CanvasFlowNode[] {
  const build = <T extends 'terminal' | 'note'>(type: T, view: { name: string; position: Position; size: Size; renamedFrom?: string; locked?: boolean }) => {
    const old =
      previous.find((node) => node.id === view.name) ??
      (view.renamedFrom ? previous.find((node) => node.id === view.renamedFrom) : undefined);
    const moving = Boolean(old?.dragging || old?.resizing);
    return {
      ...old,
      id: view.name,
      type,
      data: { name: view.name },
      position: moving && old ? old.position : view.position,
      style: moving && old ? old.style : { width: view.size.width, height: view.size.height },
      selected: old?.selected ?? false,
      draggable: !view.locked,
    } as Node<{ name: string }, T>; // Cast necessário porque o spread de união não se estreita sozinho.
  };
  const groupNodes = [...groups].sort((a, b) => a.order - b.order).map((group): GroupFlowNode => {
    const old = previous.find((node) => node.id === groupNodeId(group.id));
    const blocked = group.members.some((member) => member.kind === 'terminal' && Object.values(terminals).some((terminal) => terminal.id === member.id && terminal.locked));
    const moving = Boolean(old?.dragging || old?.resizing);
    return { ...old, id: groupNodeId(group.id), type: 'groupFrame', data: { groupId: group.id }, position: moving && old ? old.position : group.position, style: moving && old ? old.style : { ...group.size }, selected: old?.selected ?? false, draggable: !group.locked && !blocked, dragHandle: '.group-header', zIndex: -1 };
  });
  const flowNodes = (flow?.nodes ?? []).filter((node) => node.kind !== 'agent').map((node): DataFlowNode => {
    const old = previous.find((current) => current.id === flowCanvasId(node.id));
    const moving = Boolean(old?.dragging || old?.resizing);
    return { ...old, id: flowCanvasId(node.id), type: 'dataFlow', data: { flowId: node.id }, position: moving && old ? old.position : node.position, style: moving && old ? old.style : { width: node.size.width, height: Math.max(node.size.height, 130 + Math.max(node.inputs.length, node.outputs.length) * 26) }, selected: old?.selected ?? false, dragHandle: '.data-node-header' };
  });
  const portalNodes = Object.values(portals).map((portal): PortalFlowNode => {
    const old = previous.find((node) => node.id === portal.id);
    const moving = Boolean(old?.dragging || old?.resizing);
    return {
      ...old,
      id: portal.id,
      type: 'portal',
      data: { name: portal.id },
      position: moving && old ? old.position : (portal.position ?? { x: 120, y: 120 }),
      selected: old?.selected ?? false,
    };
  });
  return [...groupNodes, ...Object.values(terminals).map((view) => build('terminal', view)), ...Object.values(notes).map((view) => build('note', view)), ...flowNodes, ...portalNodes];
}
