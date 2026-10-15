import { describe, expect, it } from 'vitest';
import { NoteStore } from '../src/notes.js';

describe('NoteStore', () => {
  it('write cria com id e autor, e cada escrita sobe a revisão', () => {
    const notes = new NoteStore();
    expect(notes.write('plano', 'a', 'A')).toEqual({ revision: 1, created: true });
    expect(notes.append('plano', 'b', 'B')).toEqual({ revision: 2 });
    expect(notes.get('plano')).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'plano', content: 'ab', revision: 2, updatedBy: 'B' });
  });

  it('salvar com revisão antiga é conflito e diz quem alterou', () => {
    const notes = new NoteStore();
    notes.write('plano', 'a', 'você');
    notes.append('plano', 'b', 'A');
    expect(() => notes.save('plano', 'minha versão', 1, 'você')).toThrow(/foi alterada por A \(revisão 2\)/);
    expect(notes.get('plano')?.content).toBe('ab');
  });

  it('salvar com a revisão atual ou com null (sobrescrever) grava', () => {
    const notes = new NoteStore();
    notes.write('plano', 'a', 'A');
    expect(notes.save('plano', 'b', 1, 'você')).toMatchObject({ content: 'b', revision: 2, updatedBy: 'você' });
    expect(notes.save('plano', 'c', null, 'você')).toMatchObject({ content: 'c', revision: 3 });
  });

  it('create recusa nome existente; restore devolve as notas com id e revisão', () => {
    const notes = new NoteStore();
    notes.create('plano', '', 'você');
    expect(() => notes.create('plano', '', 'você')).toThrow(/Já existe uma nota chamada plano/);
    const other = new NoteStore();
    other.restore([{ id: 'id-1', name: 'n', content: 'x', revision: 4, updatedBy: 'A' }]);
    expect(other.get('n')).toEqual({ id: 'id-1', name: 'n', content: 'x', revision: 4, updatedBy: 'A' });
  });

  it('rename muda o nome sem alterar id, conteúdo, revisão ou autor', () => {
    const notes = new NoteStore();
    notes.write('nota', 'Plano', 'A');
    notes.append('nota', ' atualizado', 'B');
    const before = notes.get('nota')!;

    expect(notes.rename('nota', 'plano')).toEqual({ ...before, name: 'plano' });
    expect(notes.get('nota')).toBeUndefined();
    expect(notes.get('plano')).toEqual({ ...before, name: 'plano' });
  });

  it('rename recusa colisão e nota inexistente com os códigos apropriados', () => {
    const notes = new NoteStore();
    notes.create('nota', '', 'A');
    notes.create('plano', '', 'A');

    expect(() => notes.rename('nota', 'plano')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => notes.rename('ausente', 'novo')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
