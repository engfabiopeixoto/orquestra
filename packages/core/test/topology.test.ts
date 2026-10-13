import { describe, expect, it } from 'vitest';
import { OrqError } from '@orquestra/shared';
import { NoteStore } from '../src/notes.js';
import { Topology } from '../src/topology.js';

describe('Topology', () => {
  it('renomear mantém as conexões e recusa nome ocupado', () => {
    const topology = new Topology();
    topology.add('A', 'terminal');
    topology.add('B', 'terminal');
    topology.connect('A', 'B');
    topology.rename('A', 'C');
    expect(topology.isConnected('C', 'B')).toBe(true);
    expect(topology.kindOf('A')).toBeUndefined();
    expect(() => topology.rename('C', 'B')).toThrow(/Já existe/);
  });

  it('conecta nós de forma simétrica e filtra vizinhos por tipo', () => {
    const topology = new Topology();
    topology.add('A', 'terminal');
    topology.add('B', 'terminal');
    topology.add('plano', 'note');
    topology.connect('A', 'B');
    topology.connect('A', 'plano');
    expect(topology.isConnected('B', 'A')).toBe(true);
    expect(topology.neighbors('A', 'terminal')).toEqual(['B']);
    expect(topology.neighbors('A', 'note')).toEqual(['plano']);
  });

  it('recusa nome repetido entre terminais e notas', () => {
    const topology = new Topology();
    topology.add('A', 'terminal');
    expect(() => topology.add('A', 'note')).toThrow(OrqError);
  });

  it('remover um nó desfaz as conexões dele', () => {
    const topology = new Topology();
    topology.add('A', 'terminal');
    topology.add('B', 'terminal');
    topology.connect('A', 'B');
    topology.remove('B');
    expect(topology.neighbors('A')).toEqual([]);
    expect(topology.kindOf('B')).toBeUndefined();
  });

  it('recusa conectar nó inexistente', () => {
    const topology = new Topology();
    topology.add('A', 'terminal');
    expect(() => topology.connect('A', 'X')).toThrow(/não existe/);
  });

  it('recusa conexão entre duas notas e lista as arestas normalizadas', () => {
    const topology = new Topology();
    topology.add('B', 'terminal');
    topology.add('A', 'terminal');
    topology.add('n1', 'note');
    topology.add('n2', 'note');
    expect(() => topology.connect('n1', 'n2')).toThrow(/duas notas/);
    topology.connect('B', 'A');
    topology.connect('n1', 'A');
    expect(topology.edges()).toEqual([{ a: 'A', b: 'B' }, { a: 'A', b: 'n1' }]);
  });
});

describe('NoteStore', () => {
  it('cria, substitui e acrescenta subindo a revisão', () => {
    const notes = new NoteStore();
    expect(notes.write('plano', 'a', 'A')).toEqual({ revision: 1, created: true });
    expect(notes.write('plano', 'b', 'A')).toEqual({ revision: 2, created: false });
    expect(notes.append('plano', '\nc', 'A')).toEqual({ revision: 3 });
    expect(notes.get('plano')).toMatchObject({ name: 'plano', content: 'b\nc', revision: 3 });
  });

  it('append numa nota inexistente é erro NOT_FOUND', () => {
    expect(() => new NoteStore().append('x', 'y', 'A')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
