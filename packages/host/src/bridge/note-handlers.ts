import type { BridgeContext, Handlers } from './context.js';

type NoteMethod = 'note.create' | 'note.save' | 'note.rename' | 'note.remove';

/** Cria os handlers de notas no quadro. */
export function createNoteHandlers(ctx: BridgeContext): Pick<Handlers, NoteMethod> {
  return {
    'note.create': async ({ name, content, rect, groupId }) => {
      const current = ctx.requireProject();
      const placement = groupId ? ctx.prepareGroupedNode(groupId, 'note', name) : undefined;
      const note = ctx.getOrquestra().createNote(name, content);
      if (placement) current.state.place(name, placement.rect);
      else if (rect) current.state.place(name, rect);
      if (groupId) {
        current.state.grouping.assign(groupId, [{ kind: 'note', id: note.id }], ctx.groupElements());
        ctx.emitGroupLayout();
      }
      ctx.changed();
      return ctx.noteInfo(note);
    },

    'note.save': async ({ name, content, baseRevision }) => {
      ctx.requireProject();
      const note = ctx.getOrquestra().saveNote(name, content, baseRevision);
      ctx.changed();
      return ctx.noteInfo(note);
    },

    'note.rename': async ({ name, newName }) => {
      const current = ctx.requireProject();
      const note = ctx.getOrquestra().renameNote(name, newName);
      current.state.rename(name, newName);
      ctx.changed();
      ctx.opts.log.info({ note: name, method: 'note.rename', newName }, 'comando da interface');
      return ctx.noteInfo(note);
    },

    'note.remove': async ({ name }) => {
      const current = ctx.requireProject();
      ctx.getOrquestra().removeNote(name);
      current.state.forget(name);
      ctx.changed();
      return {};
    },
  };
}
