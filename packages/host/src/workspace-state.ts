import { OrqError, personaSchema, workspaceAgentSchema, type FlowGraph, type CanvasGroup, type Persona, type Size, type Viewport, type Workspace } from '@orquestra/shared';
import type { Note, TerminalDescriptor } from '@orquestra/core';
import { nextFree, NOTE_SIZE, TERMINAL_SIZE, type Rect } from './placement.js';
import { CanvasGroups } from './canvas-groups.js';

/** Layout e viewport vêm da interface; o resto vem do núcleo vivo na hora da captura. */
export class WorkspaceState {
  private readonly rects = new Map<string, Rect>();
  private readonly personaMap = new Map<string, Persona>();
  private readonly presentations = new Map<string, { blurred?: boolean; locked?: boolean }>();
  private view: Viewport;
  readonly grouping: CanvasGroups;
  private readonly elementIds = new Map<string, string>();
  private flow: FlowGraph;
  private portals: import('@orquestra/shared').BrowserNode[] = [];

  constructor(initial: { layout?: Record<string, Rect>; viewport?: Viewport; personas?: Persona[]; presentations?: Record<string, { blurred?: boolean; locked?: boolean }>; groups?: CanvasGroup[]; elementIds?: Record<string, string>; flow?: FlowGraph } = {}) {
    this.flow = initial.flow ?? { nodes: [], connections: [], autoRun: false };
    this.grouping = new CanvasGroups(initial.groups);
    for (const [name, id] of Object.entries(initial.elementIds ?? {})) this.elementIds.set(name, id);
    for (const [name, rect] of Object.entries(initial.layout ?? {})) this.rects.set(name, rect);
    this.view = initial.viewport ?? { x: 0, y: 0, zoom: 1 };
    for (const persona of initial.personas ?? []) this.personaMap.set(persona.name, persona);
    for (const [name, presentation] of Object.entries(initial.presentations ?? {})) this.presentations.set(name, presentation);
  }

  presentation(name: string): { blurred?: boolean; locked?: boolean } { return this.presentations.get(name) ?? {}; }
  setPresentation(name: string, changes: { blurred?: boolean; locked?: boolean }): void {
    const current = this.presentation(name);
    this.presentations.set(name, { ...current, ...(changes.blurred !== undefined ? { blurred: changes.blurred } : {}), ...(changes.locked !== undefined ? { locked: changes.locked } : {}) });
  }

  personas(): Persona[] {
    return [...this.personaMap.values()];
  }

  writePersona(persona: Persona): { created: boolean } {
    const parsed = personaSchema.safeParse(persona);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join('; ');
      throw new OrqError('USAGE', `Função inválida: ${message}. Corrija e tente de novo.`);
    }
    const created = !this.personaMap.has(parsed.data.name);
    this.personaMap.set(parsed.data.name, parsed.data);
    return { created };
  }

  removePersona(name: string): boolean {
    return this.personaMap.delete(name);
  }

  place(name: string, rect: Rect): void {
    this.rects.set(name, rect);
  }

  rectOf(name: string): Rect | undefined {
    return this.rects.get(name);
  }

  rename(oldName: string, newName: string): void {
    const id = this.elementIds.get(oldName);
    this.elementIds.delete(oldName);
    if (id) this.elementIds.set(newName, id);
    const rect = this.rects.get(oldName);
    this.rects.delete(oldName);
    if (rect) this.rects.set(newName, rect);
    const presentation = this.presentations.get(oldName);
    this.presentations.delete(oldName);
    if (presentation) this.presentations.set(newName, presentation);
  }

  forget(name: string): void {
    const id = this.elementIds.get(name);
    if (id) this.grouping.forget(id);
    this.elementIds.delete(name);
    this.rects.delete(name);
    this.presentations.delete(name);
  }

  setViewport(viewport: Viewport): void {
    this.view = viewport;
  }

  viewport(): Viewport {
    return this.view;
  }

  layout(): Record<string, Rect> {
    return Object.fromEntries(this.rects);
  }
  restoreLayout(layout: Record<string, Rect>): void { this.rects.clear(); for (const [name, rect] of Object.entries(layout)) this.rects.set(name, rect); }
  registerElement(name: string, id: string): void { this.elementIds.set(name, id); }
  flowGraph(): FlowGraph { return this.flow; }
  setFlowGraph(graph: FlowGraph): void { this.flow = graph; }
  browserNodes(): import('@orquestra/shared').BrowserNode[] { return this.portals.map((portal) => ({ ...portal })); }
  setBrowserNodes(portals: import('@orquestra/shared').BrowserNode[]): void { this.portals = portals; }

  capture(input: { terminals: TerminalDescriptor[]; notes: Note[]; connections: Array<{ a: string; b: string }> }): Workspace {
    const rectFor = (name: string, size: Size): Rect => {
      const known = this.rects.get(name);
      if (known) return known;
      const placed = { ...nextFree([...this.rects.values()]), ...size };
      this.rects.set(name, placed);
      return placed;
    };
    const terminals = input.terminals.flatMap((terminal) => {
      const agent = workspaceAgentSchema.safeParse(terminal.agent);
      if (!agent.success) return [];
      const { x, y, width, height } = rectFor(terminal.name, TERMINAL_SIZE);
      return [
        {
          ...terminal,
          agent: agent.data,
          position: { x, y },
          size: { width, height },
          regente: terminal.regente,
          persona: terminal.persona,
          ...this.presentation(terminal.name),
        },
      ];
    });
    const notes = input.notes.map((note) => {
      const { x, y, width, height } = rectFor(note.name, NOTE_SIZE);
      return { ...note, position: { x, y }, size: { width, height } };
    });
    const names = new Set([...terminals.map((terminal) => terminal.name), ...notes.map((note) => note.name), ...this.portals.map((portal) => portal.id)]);
    for (const element of [...terminals, ...notes]) this.registerElement(element.name, element.id);
    this.grouping.prune([...terminals.map((element) => ({ kind: 'terminal' as const, id: element.id })), ...notes.map((element) => ({ kind: 'note' as const, id: element.id })), ...this.flow.nodes.filter((node) => node.kind !== 'agent').map((node) => ({ kind: 'flow' as const, id: node.id }))]);
    const connections = input.connections.filter(({ a, b }) => names.has(a) && names.has(b));
    return { schemaVersion: 1, viewport: this.view, terminals, notes, connections, personas: this.personas(), groups: this.grouping.list(), flow: this.flow, portals: this.browserNodes() };
  }
}
