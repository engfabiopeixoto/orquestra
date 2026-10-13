import { randomUUID } from 'node:crypto';
import { OrqError } from '@orquestra/shared';

export const USER_AUTHOR = 'você';

export type Note = { id: string; name: string; content: string; revision: number; updatedBy: string };

export class NoteStore {
  private readonly notes = new Map<string, Note>();

  list(): Note[] {
    return [...this.notes.values()].map((note) => ({ ...note }));
  }

  get(name: string): Note | undefined {
    const note = this.notes.get(name);
    return note ? { ...note } : undefined;
  }

  create(name: string, content: string, author: string): Note {
    if (this.notes.has(name)) throw new OrqError('USAGE', `Já existe uma nota chamada ${name}. Escolha outro nome.`);
    const note = { id: randomUUID(), name, content, revision: 1, updatedBy: author };
    this.notes.set(name, note);
    return { ...note };
  }

  write(name: string, content: string, author: string): { revision: number; created: boolean } {
    const current = this.notes.get(name);
    if (!current) return { revision: this.create(name, content, author).revision, created: true };
    this.notes.set(name, { ...current, content, revision: current.revision + 1, updatedBy: author });
    return { revision: current.revision + 1, created: false };
  }

  append(name: string, content: string, author: string): { revision: number } {
    const current = this.require(name, 'Crie com orq note write.');
    this.notes.set(name, { ...current, content: current.content + content, revision: current.revision + 1, updatedBy: author });
    return { revision: current.revision + 1 };
  }

  /** baseRevision: revisão em que a edição começou; null sobrescreve sem checar. */
  save(name: string, content: string, baseRevision: number | null, author: string): Note {
    const current = this.require(name, 'Ela pode ter sido apagada.');
    if (baseRevision !== null && baseRevision !== current.revision) {
      throw new OrqError(
        'CONFLICT',
        `A nota ${name} foi alterada por ${current.updatedBy} (revisão ${current.revision}). Recarregue para ver a versão nova ou sobrescreva.`,
      );
    }
    const note = { ...current, content, revision: current.revision + 1, updatedBy: author };
    this.notes.set(name, note);
    return { ...note };
  }

  restore(notes: Note[]): void {
    for (const note of notes) this.notes.set(note.name, { ...note });
  }

  remove(name: string): void {
    this.notes.delete(name);
  }

  private require(name: string, hint: string): Note {
    const note = this.notes.get(name);
    if (!note) throw new OrqError('NOT_FOUND', `A nota ${name} não existe. ${hint}`);
    return note;
  }
}
