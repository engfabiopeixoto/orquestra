import type { GroupLayout, HostEvent, NoteInfo, ProjectSnapshot, QueueEntry, TerminalInfo } from '@orquestra/shared/host-protocol';
import type { CanvasGroup, Position, Size, Viewport } from '@orquestra/shared/workspace';
import { groupNodeId, inferredGroupKind } from '@orquestra/shared/group-layout';
import { flowCanvasId, type FlowSnapshot } from '@orquestra/shared/flow';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type Rect = Position & Size;
export type NoteView = NoteInfo & { position: Position; size: Size; conflict: string | null };

const NOTE_SIZE = { width: 320, height: 240 };

export type TerminalView = {
  id?: string;
  name: string;
  agent: string;
  state: TerminalInfo['state'];
  queued: number;
  cwd: string;
  args: string[];
  resume: boolean;
  regente: boolean;
  monitor: boolean;
  unloaded?: boolean;
  blurred?: boolean;
  locked?: boolean;
  position: Position;
  size: Size;
  notice: string | null;
  /** Sobe a cada reinício: o corpo do terminal usa como key e se remonta com o retrato da tela nova. */
  epoch: number;
  /** Guarda o nome anterior para o canvas preservar a seleção do nó ao renomear. */
  renamedFrom?: string;
};
export type EdgeView = { a: string; b: string };
export type AnsweredAsk = { askId: string; from: string; target: string; at: number };
export type Notice = { id: number; level: 'info' | 'warn' | 'error'; message: string };

export type AppState = {
  project: { dir: string; name: string; workspaceId?: string } | null;
  terminals: Record<string, TerminalView>;
  notes: Record<string, NoteView>;
  edges: EdgeView[];
  queues: Record<string, QueueEntry[]>;
  answers: AnsweredAsk[];
  notices: Notice[];
  focusedTerminal: string | null;
  editing: string | null;
  connectMode: boolean;
  connectFrom: string | null;
  viewport: Viewport | null;
  selectedNodes: string[];
  groups: CanvasGroup[];
  canvasViewport: Viewport | null;
  selectionMode: boolean;
  flow: FlowSnapshot;
};

export type AppActions = {
  setProject(project: AppState['project']): void;
  loadProject(snapshot: ProjectSnapshot, selection?: { focusedTerminal: string | null; selectedNodes: string[] }): void;
  applyGroupLayout(layout: GroupLayout): void;
  applyFlow(snapshot: FlowSnapshot): void;
  applyEvent(event: HostEvent): void;
  addTerminal(info: TerminalInfo): void;
  replaceTerminal(oldName: string, info: TerminalInfo): void;
  upsertNote(note: NoteInfo, rect?: Rect | null): void;
  renameNote(oldName: string, note: NoteInfo): void;
  removeNote(name: string): void;
  setNoteConflict(name: string, message: string | null): void;
  moveNode(name: string, position: Position): void;
  resizeNode(name: string, size: Size): void;
  addEdge(edge: EdgeView): void;
  removeEdge(edge: EdgeView): void;
  setFocus(name: string | null): void;
  setEditing(name: string | null): void;
  setTerminalPresentation(name: string, changes: { blurred?: boolean; locked?: boolean }): void;
  notify(level: Notice['level'], message: string): void;
  dismissNotice(id: number): void;
  setConnectMode(on: boolean): void;
  pickForConnect(name: string): EdgeView | null;
};

const DEFAULT_SIZE = { width: 640, height: 400 };
const GAP = 40;
const sameEdge = (x: EdgeView, y: EdgeView) => (x.a === y.a && x.b === y.b) || (x.a === y.b && x.b === y.a);

function nextPosition(nodes: Array<{ position: Position; size: Size }>): Position {
  if (nodes.length === 0) return { x: 80, y: 80 };
  const right = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  return { x: right + GAP, y: 80 };
}

let noticeId = 0;

export function createAppStore() {
  return createStore<AppState & AppActions>()((set, get) => ({
    project: null,
    terminals: {},
    notes: {},
    edges: [],
    queues: {},
    answers: [],
    notices: [],
    focusedTerminal: null,
    editing: null,
    connectMode: false,
    connectFrom: null,
    viewport: null,
    selectedNodes: [],
    groups: [],
    canvasViewport: null,
    selectionMode: false,
    flow: { graph: { nodes: [], connections: [], autoRun: false }, run: null, tests: null },

    setProject: (project) => set({ project, terminals: {}, notes: {}, edges: [], queues: {}, answers: [], focusedTerminal: null, editing: null, viewport: null, canvasViewport: null, groups: [], selectedNodes: [], connectMode: false, connectFrom: null, selectionMode: false, flow: { graph: { nodes: [], connections: [], autoRun: false }, run: null, tests: null } }),

    loadProject: (snapshot, selection) => {
      const rectOf = (name: string) => snapshot.layout[name];
      const terminals: Record<string, TerminalView> = {};
      for (const info of snapshot.terminals) {
        const rect = rectOf(info.name);
        terminals[info.name] = {
          ...info,
          position: rect ? { x: rect.x, y: rect.y } : nextPosition(Object.values(terminals)),
          size: rect ? { width: rect.width, height: rect.height } : DEFAULT_SIZE,
          notice: null,
          epoch: 0,
        };
      }
      const notes: Record<string, NoteView> = {};
      for (const note of snapshot.notes) {
        const rect = rectOf(note.name);
        notes[note.name] = {
          ...note,
          position: rect ? { x: rect.x, y: rect.y } : nextPosition([...Object.values(terminals), ...Object.values(notes)]),
          size: rect ? { width: rect.width, height: rect.height } : NOTE_SIZE,
          conflict: null,
        };
      }
      set({
        project: { dir: snapshot.dir, name: snapshot.name, ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}) },
        terminals,
        notes,
        edges: snapshot.edges,
        queues: snapshot.queues ?? {},
        answers: [],
        focusedTerminal: selection?.focusedTerminal && terminals[selection.focusedTerminal] ? selection.focusedTerminal : null,
        editing: null,
        connectMode: false,
        connectFrom: null,
        selectionMode: false,
        viewport: snapshot.viewport,
        canvasViewport: snapshot.viewport,
        groups: snapshot.groups ?? [],
        flow: snapshot.flow ?? { graph: { nodes: [], connections: [], autoRun: false }, run: null, tests: null },
        selectedNodes: selection?.selectedNodes.filter((name) => terminals[name] || notes[name] || snapshot.groups?.some((group) => groupNodeId(group.id) === name) || snapshot.flow?.graph.nodes.some((node) => flowCanvasId(node.id) === name)) ?? [],
      });
    },
    applyFlow: (flow) => set({ flow }),

    applyGroupLayout: ({ groups, layout }) => {
      const update = <T extends { position: Position; size: Size }>(items: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(items).map(([name, item]) => {
        const rect = layout[name];
        return [name, rect ? { ...item, position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } } : item];
      }));
      const flow = get().flow;
      set({ groups, terminals: update(get().terminals), notes: update(get().notes), flow: { ...flow, graph: { ...flow.graph, nodes: flow.graph.nodes.map((node) => { const rect = layout[flowCanvasId(node.id)]; return rect ? { ...node, position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } } : node; }) } }, selectedNodes: get().selectedNodes.filter((name) => get().terminals[name] || get().notes[name] || flow.graph.nodes.some((node) => flowCanvasId(node.id) === name) || groups.some((group) => groupNodeId(group.id) === name)) });
    },

    applyEvent: (event) => {
      if (event.type === 'flow.graph') {
        const run = get().flow.run;
        set({ flow: { ...get().flow, graph: event.graph, run: run ? { ...run, stale: event.revision ? run.revision !== event.revision : true } : null } });
      } else if (event.type === 'flow.run') {
        set({ flow: { ...get().flow, run: event.run } });
      } else if (event.type === 'flow.node') {
        const flow = get().flow;
        if (flow.run?.id === event.runId) set({ flow: { ...flow, run: { ...flow.run, results: { ...flow.run.results, [event.id]: event.result } } } });
      } else if (event.type === 'group.layout') {
        get().applyGroupLayout(event);
      } else if (event.type === 'terminal.state') {
        const view = get().terminals[event.name];
        if (view) set({ terminals: { ...get().terminals, [event.name]: { ...view, state: event.state, queued: event.queued } } });
      } else if (event.type === 'terminal.queue') {
        set({ queues: { ...get().queues, [event.name]: event.entries } });
      } else if (event.type === 'ask.answered') {
        const answers = get().answers.filter((answer) => answer.askId !== event.askId);
        answers.push({ askId: event.askId, from: event.from, target: event.target, at: Date.now() });
        set({ answers: answers.slice(-20) });
      } else if (event.type === 'terminal.removed') {
        const removedId = get().terminals[event.name]?.id;
        const { [event.name]: _removed, ...terminals } = get().terminals;
        const { [event.name]: _queue, ...queues } = get().queues;
        set({
          terminals,
          queues,
          edges: get().edges.filter((edge) => edge.a !== event.name && edge.b !== event.name),
          focusedTerminal: get().focusedTerminal === event.name ? null : get().focusedTerminal,
          editing: get().editing === event.name ? null : get().editing,
          groups: get().groups.map((group) => { const members = group.members.filter((member) => member.id !== removedId); return { ...group, members, kind: inferredGroupKind(members, group.kind) }; }),
        });
      } else if (event.type === 'terminal.notice') {
        const view = get().terminals[event.name];
        // Mensagem vazia limpa o aviso (ex.: a conversa voltou do segundo plano).
        if (view) set({ terminals: { ...get().terminals, [event.name]: { ...view, notice: event.message || null } } });
      } else if (event.type === 'notice') {
        get().notify(event.level, event.message);
      } else if (event.type === 'note.changed') {
        if (event.renamedFrom) get().renameNote(event.renamedFrom, event.note);
        else get().upsertNote(event.note, event.rect);
        if (event.connectedTo) get().addEdge({ a: event.connectedTo, b: event.note.name });
      } else if (event.type === 'note.removed') {
        get().removeNote(event.name);
      } else if (event.type === 'terminal.added') {
        const view: TerminalView = {
          ...event.info,
          position: { x: event.rect.x, y: event.rect.y },
          size: { width: event.rect.width, height: event.rect.height },
          notice: null,
          epoch: 0,
        };
        set({ terminals: { ...get().terminals, [event.info.name]: view } });
        if (event.connectedTo) get().addEdge({ a: event.connectedTo, b: event.info.name });
      } else if (event.type === 'edge.added') {
        get().addEdge({ a: event.a, b: event.b });
      } else if (event.type === 'edge.removed') {
        get().removeEdge({ a: event.a, b: event.b });
      }
    },

    addTerminal: (info) =>
      set({
        terminals: {
          ...get().terminals,
          [info.name]: {
            ...info,
            unloaded: Boolean(info.unloaded),
            position: nextPosition([...Object.values(get().terminals), ...Object.values(get().notes)]),
            size: DEFAULT_SIZE,
            notice: null,
            epoch: 0,
          },
        },
      }),

    replaceTerminal: (oldName, info) => {
      const { [oldName]: old, ...rest } = get().terminals;
      if (!old) return;
      const isRename = oldName !== info.name;
      let focusedTerminal = get().focusedTerminal;
      if (focusedTerminal === oldName) {
        focusedTerminal = isRename ? info.name : null;
      }

      set({
        terminals: {
          ...rest,
          [info.name]: {
            ...old,
            ...info,
            unloaded: Boolean(info.unloaded),
            notice: null,
            epoch: isRename ? old.epoch : old.epoch + 1,
            renamedFrom: isRename ? oldName : undefined,
          },
        },
        edges: get().edges.map((edge) => ({
          a: edge.a === oldName ? info.name : edge.a,
          b: edge.b === oldName ? info.name : edge.b,
        })),
        focusedTerminal,
        editing: get().editing === oldName ? null : get().editing,
        selectedNodes: get().selectedNodes.map((name) => name === oldName ? info.name : name),
      });
    },

    upsertNote: (note, rect) => {
      const current = get().notes[note.name];
      const all = [...Object.values(get().terminals), ...Object.values(get().notes)];
      const position = rect ? { x: rect.x, y: rect.y } : (current?.position ?? nextPosition(all));
      const size = rect ? { width: rect.width, height: rect.height } : (current?.size ?? NOTE_SIZE);
      set({ notes: { ...get().notes, [note.name]: { ...note, position, size, conflict: null } } });
    },

    renameNote: (oldName, note) => {
      const currentState = get();
      const existing = currentState.notes[oldName] ?? currentState.notes[note.name];
      if (!existing) return;
      const { [oldName]: _old, ...rest } = currentState.notes;
      set({
        notes: { ...rest, [note.name]: { ...existing, ...note, position: existing.position, size: existing.size, conflict: existing.conflict } },
        edges: currentState.edges.map((edge) => ({ a: edge.a === oldName ? note.name : edge.a, b: edge.b === oldName ? note.name : edge.b })),
        selectedNodes: currentState.selectedNodes.map((name) => name === oldName ? note.name : name),
      });
    },

    removeNote: (name) => {
      const removedId = get().notes[name]?.id;
      const { [name]: _removed, ...notes } = get().notes;
      set({ notes, edges: get().edges.filter((edge) => edge.a !== name && edge.b !== name), groups: get().groups.map((group) => { const members = group.members.filter((member) => member.id !== removedId); return { ...group, members, kind: inferredGroupKind(members, group.kind) }; }) });
    },

    setNoteConflict: (name, message) => {
      const note = get().notes[name];
      if (note) set({ notes: { ...get().notes, [name]: { ...note, conflict: message } } });
    },

    moveNode: (name, position) => {
      if (name.startsWith('flow:')) { const flow = get().flow; return set({ flow: { ...flow, graph: { ...flow.graph, nodes: flow.graph.nodes.map((node) => flowCanvasId(node.id) === name ? { ...node, position } : node) } } }); }
      const term = get().terminals[name];
      if (term) return set({ terminals: { ...get().terminals, [name]: { ...term, position } } });
      const note = get().notes[name];
      if (note) set({ notes: { ...get().notes, [name]: { ...note, position } } });
    },

    resizeNode: (name, size) => {
      const term = get().terminals[name];
      if (term) return set({ terminals: { ...get().terminals, [name]: { ...term, size } } });
      const note = get().notes[name];
      if (note) set({ notes: { ...get().notes, [name]: { ...note, size } } });
    },

    addEdge: (edge) => {
      if (get().edges.some((existing) => sameEdge(existing, edge))) return;
      set({ edges: [...get().edges, edge] });
    },

    removeEdge: (edge) => set({ edges: get().edges.filter((existing) => !sameEdge(existing, edge)) }),

    setFocus: (name) => set({ focusedTerminal: name }),

    setEditing: (name) => set({ editing: name }),
    setTerminalPresentation: (name, changes) => {
      const terminal = get().terminals[name];
      if (terminal) set({ terminals: { ...get().terminals, [name]: { ...terminal, ...changes } }, focusedTerminal: changes.blurred && get().focusedTerminal === name ? null : get().focusedTerminal });
    },

    notify: (level, message) => set({ notices: [...get().notices, { id: ++noticeId, level, message }] }),

    dismissNotice: (id) => set({ notices: get().notices.filter((notice) => notice.id !== id) }),

    setConnectMode: (on) => set({ connectMode: on, connectFrom: null }),

    pickForConnect: (name) => {
      const from = get().connectFrom;
      if (!from) {
        set({ connectFrom: name });
        return null;
      }
      if (from === name) {
        set({ connectFrom: null });
        return null;
      }
      set({ connectFrom: null, connectMode: false });
      return { a: from, b: name };
    },
  }));
}

export const appStore = createAppStore();

export function useApp<T>(selector: (state: AppState & AppActions) => T): T {
  return useStore(appStore, selector);
}

export function layoutOf(state: AppState, name: string): Rect | null {
  const node = state.terminals[name] ?? state.notes[name];
  if (!node) { const data = state.flow.graph.nodes.find((node) => flowCanvasId(node.id) === name); return data ? { ...data.position, ...data.size, height: Math.max(data.size.height, 130 + Math.max(data.inputs.length, data.outputs.length) * 26) } : null; }
  return { ...node.position, ...node.size };
}
