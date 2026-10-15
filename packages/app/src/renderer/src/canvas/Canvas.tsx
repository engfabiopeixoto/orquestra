import {
  ConnectionMode,
  SelectionMode,
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type OnBeforeDelete,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { groupDropTarget } from '@orquestra/shared/group-layout';
import type { CanvasMotion } from '@orquestra/shared/args';
import type { Position } from '@orquestra/shared/workspace';
import { createCommandApi, type CommandApi } from '../api';
import { activeWorkspaceId } from '../workspace-context';
import { appStore, layoutOf, useApp } from '../store';
import { NoteNode } from '../notes/NoteNode';
import { TerminalNode } from '../terminal/TerminalNode';
import { buildFlowNodes, type CanvasFlowNode } from './flow-nodes';
import { focusTerminalRequest } from './focus-terminal';
import { canvasShortcut } from './shortcuts';
import { useWorkspaces, workspaceStore } from '../workspaces';
import { GroupFrame } from '../groups/GroupFrame';
import { canvasElements, recoverGroupLayout } from '../groups/helpers';
import { buildClosestEdges } from './edge-routing';
import { disconnectEdge, type DisconnectableEdge } from './disconnect-edge';
import { DisconnectEdgeContext, RemovableEdge } from './RemovableEdge';
import { PortalNode } from '../portal/PortalNode';
import { portalStore, usePortalStore } from '../portal/portal-state';
import { DataNode } from '../flow/DataNode';
import { dataEdges } from '../flow/flow-edges';
import { connectData } from '../flow/canvas-actions';

const nodeTypes = { terminal: TerminalNode, note: NoteNode, groupFrame: GroupFrame, dataFlow: DataNode, portal: PortalNode };
const edgeTypes = { removable: RemovableEdge };

async function connect(a: string, b: string, api: CommandApi) {
  try {
    await api.command('edge.connect', { a, b });
    appStore.getState().addEdge({ a, b });
  } catch (error) {
    appStore.getState().notify('error', (error as Error).message);
  }
}

export interface CanvasDeleteParams {
  deletedNodes: CanvasFlowNode[];
  deletedEdges: Edge[];
  api: CommandApi;
  workspaceId?: string;
  selectedEdges?: ReadonlySet<string>;
  onRemoveRequest(name: string): void;
}

export function filterEdgesToDelete<E extends Edge>(
  deletedEdges: E[],
  deletedNodes: Array<{ id: string }>,
  selectedEdgeIds?: ReadonlySet<string>,
): E[] {
  const deletedNodeIds = new Set(deletedNodes.map((node) => node.id));
  return deletedEdges.filter(
    (edge) =>
      Boolean(edge.selected || selectedEdgeIds?.has(edge.id)) &&
      !deletedNodeIds.has(edge.source) &&
      !deletedNodeIds.has(edge.target),
  );
}

export async function handleCanvasDelete({
  deletedNodes,
  deletedEdges,
  api,
  workspaceId,
  selectedEdges,
  onRemoveRequest,
}: CanvasDeleteParams): Promise<boolean> {
  for (const node of deletedNodes) {
    if (node.type === 'groupFrame') {
      try { appStore.getState().applyGroupLayout(await api.command('group.remove', { id: node.data.groupId })); }
      catch (error) { await recoverGroupLayout(api, error); }
    } else if (node.type === 'note') {
      if (window.confirm(`Apagar a nota ${node.id}?`)) {
        try {
          await api.command('note.remove', { name: node.id });
          appStore.getState().removeNote(node.id);
        } catch (error) {
          appStore.getState().notify('error', (error as Error).message);
        }
      }
    } else if (node.type === 'dataFlow') {
      try { appStore.getState().applyFlow(await api.command('flow.remove', { id: node.data.flowId })); }
      catch (error) { appStore.getState().notify('error', (error as Error).message); }
    } else if (node.type === 'portal') {
      if (window.confirm(`Fechar o portal ${node.id}?`)) {
        void window.orquestra?.portal?.destroy(node.id, workspaceId);
        portalStore.getState().removePortal(node.id);
      }
    } else {
      // Terminais são removidos pelo fluxo com confirmação
      onRemoveRequest(node.id);
    }
  }
  const standaloneEdges = filterEdgesToDelete(deletedEdges, deletedNodes, selectedEdges);
  for (const edge of standaloneEdges) await disconnectEdge(edge, api);
  return false;
}

export function Canvas({ snapToGrid = true, motion = 'contained', onRemoveRequest, onNewGroup }: { snapToGrid?: boolean; motion?: CanvasMotion; onRemoveRequest(name: string): void; onNewGroup?(selection: boolean, position?: Position): void }) {
  const workspaceId = activeWorkspaceId();
  const api = useMemo(() => createCommandApi(window.orquestra.invoke, () => workspaceId), [workspaceId]);
  const terminals = useApp((state) => state.terminals);
  const notes = useApp((state) => state.notes);
  const groups = useApp((state) => state.groups);
  const selectionMode = useApp((state) => state.selectionMode);
  const edgesView = useApp((state) => state.edges);
  const focused = useApp((state) => state.focusedTerminal);
  const connectMode = useApp((state) => state.connectMode);
  const initialViewport = useApp((state) => state.viewport);
  const selection = useApp((state) => state.selectedNodes);
  const focusRequest = useWorkspaces((state) => state.focusRequest);
  const portals = usePortalStore((state) => state.portals);
  const flow = useApp((state) => state.flow);
  const workspacePortals = useMemo(() => {
    const wsId = workspaceId || 'default';
    return Object.fromEntries(Object.entries(portals).filter(([_, p]) => p.workspaceId === wsId));
  }, [portals, workspaceId]);
  const initialNodes = useMemo(() => buildFlowNodes(terminals, notes, [], groups, flow.graph, workspacePortals).map((node) => ({ ...node, selected: selection.includes(node.id) })), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>(initialNodes);
  const { zoomTo, fitView, getViewport, setViewport, getNode, setCenter, screenToFlowPosition } = useReactFlow();
  const { zoom } = useViewport();
  const isFullZoom = Math.abs(zoom - 1) <= 0.001;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const groupDrag = useRef<{ id: string; origin: Position; positions: Map<string, Position>; memberNames: Set<string> } | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; position: Position } | null>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!paneMenu) return;
    const outside = (event: PointerEvent) => { if (!paneMenuRef.current?.contains(event.target as Node)) setPaneMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPaneMenu(null); };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [paneMenu]);

  useEffect(() => {
    if (!focusRequest || (focusRequest.workspaceId && focusRequest.workspaceId !== workspaceId)) return;
    if (focusTerminalRequest(focusRequest.name, {
          getNode,
          setCenter,
          setFocus: (focus) => appStore.getState().setFocus(focus),
          sizeOf: (terminal) => appStore.getState().terminals[terminal]?.size,
        })) workspaceStore.setState({ focusRequest: null });
  }, [nodes, focusRequest, getNode, setCenter, workspaceId]);

  useEffect(() => {
    if (initialViewport) void setViewport(initialViewport);
  }, [initialViewport, setViewport]);

  useEffect(() => {
    setNodes((previous) => buildFlowNodes(terminals, notes, previous, groups, flow.graph, workspacePortals).map((node) => node.type === 'groupFrame' ? { ...node, data: { ...node.data, dropTarget: node.data.groupId === dropTarget } } : node));
  }, [terminals, notes, groups, dropTarget, flow.graph, workspacePortals, setNodes]);

  // As arestas são derivadas da store; a seleção vive aqui para o Delete e o destaque funcionarem.
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const baseEdges = useMemo(() => [...buildClosestEdges(edgesView, nodes), ...dataEdges(flow.graph, terminals)], [edgesView, nodes, flow.graph, terminals]);
  const edges = useMemo(() => baseEdges.map((edge) => selectedEdges.has(edge.id) ? { ...edge, selected: true } : edge), [baseEdges, selectedEdges]);
  useEffect(() => {
    const ids = new Set(baseEdges.map((edge) => edge.id));
    setSelectedEdges((previous) => {
      const kept = [...previous].filter((id) => ids.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [baseEdges]);

  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; edge: DisconnectableEdge } | null>(null);
  const edgeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!edgeMenu) return;
    const outside = (event: PointerEvent) => { if (!edgeMenuRef.current?.contains(event.target as Node)) setEdgeMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setEdgeMenu(null); };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [edgeMenu]);
  const disconnect = useCallback((edge: DisconnectableEdge) => void disconnectEdge(edge, api), [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isFull = Math.abs(getViewport().zoom - 1) <= 0.001;
      const action = canvasShortcut(event, {
        terminalFocused: appStore.getState().focusedTerminal !== null,
        isFullZoom: isFull,
      });
      if (!action) return;
      event.preventDefault();
      if (action === 'zoom-reset') void zoomTo(1, { duration: 150 });
      else void fitView({ duration: 200, padding: 0.1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomTo, fitView, getViewport]);

  const onBeforeDelete: OnBeforeDelete<CanvasFlowNode, Edge> = ({ nodes: deletedNodes, edges: deletedEdges }) =>
    handleCanvasDelete({ deletedNodes, deletedEdges, api, workspaceId, selectedEdges, onRemoveRequest });

  return (
    <DisconnectEdgeContext.Provider value={disconnect}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      data-motion={motion}
      onEdgesChange={(changes) => {
        if (workspaceId !== activeWorkspaceId()) return;
        const picks = changes.flatMap((change) => change.type === 'select' ? [change] : []);
        if (!picks.length) return;
        setSelectedEdges((previous) => {
          const next = new Set(previous);
          for (const change of picks) if (change.selected) next.add(change.id); else next.delete(change.id);
          return next;
        });
      }}
      onEdgeContextMenu={(event, edge) => {
        event.preventDefault();
        setEdgeMenu({ x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 50), edge: { source: edge.source, target: edge.target, data: edge.data } });
      }}
      snapToGrid={snapToGrid}
      snapGrid={[20, 20]}
      onNodesChange={(changes) => {
        if (workspaceId !== activeWorkspaceId()) return;
        onNodesChange(changes);
        const selected = new Set(appStore.getState().selectedNodes);
        let changed = false;
        for (const change of changes) if (change.type === 'select') {
          if (change.selected) selected.add(change.id); else selected.delete(change.id);
          changed = true;
        }
        if (changed) appStore.setState({ selectedNodes: [...selected] });
      }}
      onNodeDragStart={(_event, node) => {
        if (node.type !== 'groupFrame') return;
        const group = appStore.getState().groups.find((group) => group.id === node.data.groupId);
        if (!group) return;
        const memberNames = new Set(canvasElements(appStore.getState()).filter((element) => group.members.some((member) => member.id === element.id)).map((element) => element.name));
        groupDrag.current = { id: group.id, origin: group.position, positions: new Map(nodes.map((node) => [node.id, { ...node.position }])), memberNames };
      }}
      onNodeDrag={(_event, node) => {
        const drag = groupDrag.current;
        if (node.type === 'groupFrame' && drag) {
          const dx = node.position.x - drag.origin.x, dy = node.position.y - drag.origin.y;
          setNodes((previous) => previous.map((current) => {
            const origin = drag.positions.get(current.id);
            if (!origin || current.id === node.id) return current;
            return drag.memberNames.has(current.id) ? { ...current, dragging: true, position: { x: origin.x + dx, y: origin.y + dy } } : { ...current, dragging: false, position: origin };
          }));
          return;
        }
        const rect = layoutOf(appStore.getState(), node.id);
        if (rect) setDropTarget(groupDropTarget(appStore.getState().groups, { ...rect, ...node.position }));
      }}
      onNodeDragStop={(_event, node, dragged) => {
        if (node.type === 'groupFrame') {
          groupDrag.current = null;
          setNodes((previous) => previous.map((current) => ({ ...current, dragging: false })));
          void api.command('group.move', { id: node.data.groupId, position: node.position }).then((result) => appStore.getState().applyGroupLayout(result)).catch((error) => recoverGroupLayout(api, error));
          return;
        }
        if (node.type === 'portal') {
          portalStore.getState().updatePortal(node.id, { position: node.position });
          return;
        }
        setDropTarget(null);
        const state = appStore.getState();
        const moved = (dragged.length ? dragged : [node]).filter((current) => current.type !== 'groupFrame' && current.type !== 'portal');
        const elements = canvasElements(state);
        const nodesToSave = moved.flatMap((current) => {
          const rect = layoutOf(state, current.id);
          if (!rect) return [];
          state.moveNode(current.id, current.position);
          return [{ name: current.id, ...rect, ...current.position }];
        });
        const assignments = nodesToSave.flatMap(({ name, ...rect }) => {
          const element = elements.find((element) => element.name === name);
          return element ? [{ member: { kind: element.kind, id: element.id }, groupId: groupDropTarget(state.groups, rect) }] : [];
        });
        const ordinary = nodesToSave.filter((node) => !node.name.startsWith('flow:'));
        const processing = nodesToSave.filter((node) => node.name.startsWith('flow:'));
        const save = async () => {
          if (ordinary.length) await api.command('layout.update', { nodes: ordinary, ...(state.groups.length ? { groupAssignments: assignments.filter((item) => item.member.kind !== 'flow') } : {}) });
          if (processing.length) await api.command('flow.move', { nodes: processing.map((node) => ({ id: node.name.slice(5), position: { x: node.x, y: node.y }, size: { width: node.width, height: node.height } })), ...(state.groups.length ? { groupAssignments: assignments.filter((item) => item.member.kind === 'flow') } : {}) });
        };
        void save().catch((error) => recoverGroupLayout(api, error));
      }}
      onMoveEnd={(_event, viewport) => { appStore.setState({ canvasViewport: viewport }); void api.command('layout.update', { nodes: [], viewport }).catch(() => {}); }}
      onConnect={(connection: Connection) => void connectData(connection, api).then((handled) => { if (!handled) void connect(connection.source, connection.target, api); })}
      onNodeClick={(_event, node) => {
        if (node.type === 'groupFrame' || node.type === 'dataFlow') return;
        if (!connectMode) return;
        const edge = appStore.getState().pickForConnect(node.id);
        if (edge) void connect(edge.a, edge.b, api);
      }}
      onPaneClick={() => appStore.getState().setFocus(null)}
      onPaneContextMenu={(event) => {
        if (!onNewGroup) return;
        event.preventDefault();
        setPaneMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
      }}
      onBeforeDelete={onBeforeDelete}
      deleteKeyCode={isFullZoom && focused ? null : 'Delete'}
      connectionMode={ConnectionMode.Loose}
      zoomOnScroll={false}
      zoomActivationKeyCode="Control"
      panOnScroll
      selectionOnDrag={selectionMode}
      selectionMode={SelectionMode.Partial}
      panOnDrag={!selectionMode}
      onSelectionEnd={() => appStore.setState({ selectionMode: false })}
      elevateNodesOnSelect={false}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      {snapToGrid ? <Background variant={BackgroundVariant.Dots} gap={20} color="#262b35" size={1} /> : null}
    </ReactFlow>
    {paneMenu && onNewGroup ? createPortal(<div ref={paneMenuRef} className="ctx ctx-menu group-menu" role="menu" aria-label="Organizar canvas" style={{ position: 'fixed', left: paneMenu.x, top: paneMenu.y }}>
      <button role="menuitem" onClick={() => { onNewGroup(false, paneMenu.position); setPaneMenu(null); }}>Criar grupo aqui</button>
      <button role="menuitem" disabled={!selection.some((name) => terminals[name] || notes[name])} onClick={() => { onNewGroup(true, paneMenu.position); setPaneMenu(null); }}>Agrupar seleção</button>
    </div>, document.body) : null}
    {edgeMenu ? createPortal(<div ref={edgeMenuRef} className="ctx ctx-menu edge-menu" role="menu" aria-label="Conexão" style={{ position: 'fixed', left: edgeMenu.x, top: edgeMenu.y }}>
      <button role="menuitem" onClick={() => { disconnect(edgeMenu.edge); setEdgeMenu(null); }}>Desconectar</button>
    </div>, document.body) : null}
    </DisconnectEdgeContext.Provider>
  );
}
