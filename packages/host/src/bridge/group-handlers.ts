import { randomUUID } from 'node:crypto';
import type { Orquestra } from '@orquestra/core';
import { GROUP_HEADER, GROUP_PADDING, OrqError, type GroupElement, type GroupLayout } from '@orquestra/shared';
import { NOTE_SIZE, TERMINAL_SIZE } from '../placement.js';
import type { BridgeContext, Handlers, OpenProject } from './context.js';

type GroupAndPortalMethod =
  | 'portal.registry'
  | 'portal.register'
  | 'portal.unregister'
  | 'group.layout'
  | 'group.create'
  | 'group.update'
  | 'group.assign'
  | 'group.members'
  | 'group.move'
  | 'group.resize'
  | 'group.fit'
  | 'group.remove'
  | 'layout.update';

/** Utilitários de geometria e grupos usados na criação e movimentação de nós agrupados. */
export function createGroupHelpers(deps: {
  requireProject: () => OpenProject;
  getOrquestra: () => Orquestra;
  capture: (current: OpenProject) => unknown;
  changed: () => void;
  send: BridgeContext['opts']['send'];
}) {
  function groupElements(): GroupElement[] {
    const current = deps.requireProject();
    const orquestra = deps.getOrquestra();
    deps.capture(current); // Populate default geometry and remove references to missing elements.
    return [
      ...orquestra.describeTerminals().map((terminal) => ({
        kind: 'terminal' as const,
        id: terminal.id,
        name: terminal.name,
        rect: current.state.rectOf(terminal.name)!,
        locked: Boolean(current.state.presentation(terminal.name).locked),
      })),
      ...orquestra.notes.list().map((note) => ({
        kind: 'note' as const,
        id: note.id,
        name: note.name,
        rect: current.state.rectOf(note.name)!,
        locked: false,
      })),
    ];
  }

  function groupLayout(): GroupLayout {
    const current = deps.requireProject();
    return { groups: current.state.grouping.list(), layout: current.state.layout() };
  }

  function emitGroupLayout(): GroupLayout {
    const result = groupLayout();
    deps.changed();
    deps.send({ kind: 'event', event: { type: 'group.layout', ...result } });
    return result;
  }

  function prepareGroupedNode(groupId: string, kind: 'terminal' | 'note', name: string) {
    const current = deps.requireProject();
    const elements = groupElements();
    const group = current.state.grouping.list().find((item) => item.id === groupId);
    if (!group) throw new OrqError('NOT_FOUND', 'O grupo não existe neste workspace.');
    const members = elements.filter((element) => group.members.some((member) => member.id === element.id));
    const rect = {
      x: group.position.x + GROUP_PADDING,
      y: members.length
        ? Math.max(...members.map((element) => element.rect.y + element.rect.height)) + GROUP_PADDING
        : group.position.y + GROUP_HEADER + GROUP_PADDING,
      ...(kind === 'terminal' ? TERMINAL_SIZE : NOTE_SIZE),
    };
    const id = randomUUID();
    current.state.grouping.validateAssignment(groupId, { id, kind }, [...elements, { id, kind, name, rect, locked: false }]);
    return { id, rect };
  }

  return { groupElements, groupLayout, emitGroupLayout, prepareGroupedNode };
}

/** Cria os handlers de grupos, portais de navegador no canvas e layout. */
export function createGroupHandlers(ctx: BridgeContext): Pick<Handlers, GroupAndPortalMethod> {
  return {
    'portal.registry': async () => ({ portals: ctx.requireProject().state.browserNodes() }),

    'portal.register': async (portal) => {
      const current = ctx.requireProject();
      const existing = current.state.browserNodes();
      const orquestra = ctx.getOrquestra();
      const kind = orquestra.topology.kindOf(portal.id);
      if (kind && kind !== 'portal') throw new OrqError('USAGE', 'O identificador do navegador já pertence a outro elemento.');
      if (!kind) {
        if (existing.length >= 2) throw new OrqError('USAGE', 'Limite de dois navegadores por workspace.');
        orquestra.topology.add(portal.id, 'portal');
      }
      current.state.setBrowserNodes([...existing.filter((node) => node.id !== portal.id), portal]);
      ctx.changed();
      return {};
    },

    'portal.unregister': async ({ id }) => {
      const current = ctx.requireProject();
      const orquestra = ctx.getOrquestra();
      for (const other of orquestra.topology.neighbors(id)) {
        ctx.opts.send({ kind: 'event', event: { type: 'edge.removed', a: id, b: other } });
      }
      if (orquestra.topology.kindOf(id) === 'portal') orquestra.topology.remove(id);
      current.state.setBrowserNodes(current.state.browserNodes().filter((node) => node.id !== id));
      ctx.changed();
      return {};
    },

    'group.layout': async () => {
      ctx.groupElements();
      return ctx.groupLayout();
    },
    'group.create': async (input) => {
      ctx.requireProject().state.grouping.create(input, ctx.groupElements());
      return ctx.emitGroupLayout();
    },
    'group.update': async (input) => {
      ctx.requireProject().state.grouping.update(input);
      return ctx.emitGroupLayout();
    },
    'group.assign': async ({ id, members }) => {
      ctx.requireProject().state.grouping.assign(id, members, ctx.groupElements());
      return ctx.emitGroupLayout();
    },
    'group.members': async ({ id, members }) => {
      ctx.requireProject().state.grouping.setMembers(id, members, ctx.groupElements());
      return ctx.emitGroupLayout();
    },
    'group.move': async ({ id, position }) => {
      const current = ctx.requireProject();
      const moved = current.state.grouping.move(id, position, ctx.groupElements());
      for (const { name, ...rect } of moved) current.state.place(name, rect);
      return ctx.emitGroupLayout();
    },
    'group.resize': async ({ id, rect }) => {
      ctx.requireProject().state.grouping.resize(id, rect, ctx.groupElements());
      return ctx.emitGroupLayout();
    },
    'group.fit': async ({ id }) => {
      ctx.requireProject().state.grouping.fit(id, ctx.groupElements());
      return ctx.emitGroupLayout();
    },
    'group.remove': async ({ id }) => {
      ctx.requireProject().state.grouping.remove(id);
      return ctx.emitGroupLayout();
    },

    'layout.update': async ({ nodes, viewport, groupAssignments }) => {
      const current = ctx.requireProject();
      const orquestra = ctx.getOrquestra();
      for (const { name } of nodes) if (!orquestra.topology.kindOf(name)) throw new OrqError('NOT_FOUND', `Elemento ${name} não existe.`);
      const before = { layout: current.state.layout(), groups: current.state.grouping.list() };
      try {
        for (const { name, ...rect } of nodes) if (!current.state.presentation(name).locked) current.state.place(name, rect);
        for (const assignment of groupAssignments ?? []) {
          current.state.grouping.assign(assignment.groupId, [assignment.member], ctx.groupElements());
        }
        if (current.state.grouping.list().length && nodes.length) current.state.grouping.expand(ctx.groupElements());
      } catch (error) {
        current.state.restoreLayout(before.layout);
        current.state.grouping.replace(before.groups);
        throw error;
      }
      if (viewport) current.state.setViewport(viewport);
      ctx.changed();
      if (current.state.grouping.list().length && (nodes.length || groupAssignments?.length)) ctx.emitGroupLayout();
      return {};
    },
  };
}
