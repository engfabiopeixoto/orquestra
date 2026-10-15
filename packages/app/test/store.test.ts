import { describe, expect, it } from 'vitest';
import { createAppStore } from '../src/renderer/src/store';

const info = (name: string) => ({ name, agent: 'shell', state: 'starting' as const, queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false });

describe('estado da interface', () => {
  it('aplica estado, fila e aviso aos terminais', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().applyEvent({ type: 'terminal.state', name: 'A', state: 'busy', queued: 2 });
    store.getState().applyEvent({ type: 'terminal.queue', name: 'A', entries: [{ askId: 'x', from: 'B', preview: 'oi', status: 'running', kind: 'prompt' }] });
    expect(store.getState().terminals.A).toMatchObject({ state: 'busy', queued: 2 });
    expect(store.getState().queues.A).toHaveLength(1);
  });

  it('guarda as 20 respostas mais recentes e limpa ao trocar ou carregar projeto', () => {
    const store = createAppStore();
    for (let index = 0; index < 21; index++) {
      store.getState().applyEvent({ type: 'ask.answered', askId: `ask-${index}`, from: 'S', target: 'T' });
    }
    expect(store.getState().answers).toHaveLength(20);
    expect(store.getState().answers[0]).toMatchObject({ askId: 'ask-1', from: 'S', target: 'T' });
    expect(store.getState().answers.at(-1)).toMatchObject({ askId: 'ask-20', from: 'S', target: 'T' });

    store.getState().setProject({ dir: 'C:/q', name: 'q' });
    expect(store.getState().answers).toEqual([]);
    store.getState().applyEvent({ type: 'ask.answered', askId: 'loaded', from: 'S', target: 'T' });
    store.getState().loadProject({
      dir: 'C:/p', name: 'p', terminals: [], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(store.getState().answers).toEqual([]);
  });

  it('aviso do terminal aparece e uma mensagem vazia o limpa', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().applyEvent({ type: 'terminal.notice', name: 'A', message: 'Conversa em segundo plano' });
    expect(store.getState().terminals.A!.notice).toBe('Conversa em segundo plano');
    store.getState().applyEvent({ type: 'terminal.notice', name: 'A', message: '' });
    expect(store.getState().terminals.A!.notice).toBeNull();
  });

  it('remoção limpa conexões e fila', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().addTerminal(info('B'));
    store.getState().addEdge({ a: 'A', b: 'B' });
    store.getState().applyEvent({ type: 'terminal.removed', name: 'A' });
    expect(store.getState().terminals.A).toBeUndefined();
    expect(store.getState().edges).toEqual([]);
  });

  it('conexões não têm direção nem duplicata', () => {
    const store = createAppStore();
    store.getState().addEdge({ a: 'A', b: 'B' });
    store.getState().addEdge({ a: 'B', b: 'A' });
    expect(store.getState().edges).toEqual([{ a: 'A', b: 'B' }]);
    store.getState().removeEdge({ a: 'B', b: 'A' });
    expect(store.getState().edges).toEqual([]);
  });

  it('terminais novos ficam à direita do último', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().addTerminal(info('B'));
    const { A, B } = store.getState().terminals;
    expect(B!.position.x).toBeGreaterThanOrEqual(A!.position.x + A!.size.width);
  });

  it('modo conectar: primeiro clique escolhe a origem, o segundo devolve a conexão', () => {
    const store = createAppStore();
    store.getState().setConnectMode(true);
    expect(store.getState().pickForConnect('A')).toBeNull();
    expect(store.getState().pickForConnect('B')).toEqual({ a: 'A', b: 'B' });
    expect(store.getState().connectMode).toBe(false);
  });

  it('reiniciar mantém posição e conexões e sobe o epoch; renomear troca o nome nas conexões', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().addTerminal(info('B'));
    store.getState().addEdge({ a: 'A', b: 'B' });
    const position = store.getState().terminals.A!.position;
    store.getState().replaceTerminal('A', { ...info('A'), state: 'starting' });
    expect(store.getState().terminals.A).toMatchObject({ position, epoch: 1 });
    store.getState().replaceTerminal('A', info('C'));
    expect(store.getState().terminals.C).toMatchObject({ position, epoch: 1 });
    expect(store.getState().edges).toEqual([{ a: 'C', b: 'B' }]);
  });

  it('abrir outro projeto zera os terminais', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().setProject({ dir: 'C:/q', name: 'q' });
    expect(store.getState().terminals).toEqual({});
  });

  it('renomear transfere o foco para o novo nome', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().setFocus('A');
    expect(store.getState().focusedTerminal).toBe('A');
    store.getState().replaceTerminal('A', info('B'));
    expect(store.getState().focusedTerminal).toBe('B');
  });

  it('reiniciar limpa o foco para não apontar para terminal inexistente/antigo', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    store.getState().setFocus('A');
    expect(store.getState().focusedTerminal).toBe('A');
    store.getState().replaceTerminal('A', info('A'));
    expect(store.getState().focusedTerminal).toBeNull();
  });

  const snapshot = {
    dir: 'C:/p',
    name: 'p',
    terminals: [{ ...info('A'), resume: true }],
    notes: [{ name: 'plano', content: '# x', revision: 2, updatedBy: 'A' }],
    edges: [{ a: 'A', b: 'plano' }],
    layout: { A: { x: 10, y: 20, width: 500, height: 300 }, plano: { x: 600, y: 20, width: 320, height: 240 } },
    viewport: { x: 1, y: 2, zoom: 0.5 },
  };

  it('loadProject restaura terminais, notas, conexões, layout e viewport', () => {
    const store = createAppStore();
    store.getState().loadProject(snapshot);
    const state = store.getState();
    expect(state.project).toEqual({ dir: 'C:/p', name: 'p' });
    expect(state.terminals.A).toMatchObject({ position: { x: 10, y: 20 }, size: { width: 500, height: 300 } });
    expect(state.notes.plano).toMatchObject({ content: '# x', position: { x: 600, y: 20 }, size: { width: 320, height: 240 }, conflict: null });
    expect(state.edges).toEqual([{ a: 'A', b: 'plano' }]);
    expect(state.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
  });

  it('nota de agente chega com posição e conexão pelo evento', () => {
    const store = createAppStore();
    store.getState().loadProject({ ...snapshot, notes: [], edges: [] });
    store.getState().applyEvent({
      type: 'note.changed',
      note: { name: 'novo', content: 'x', revision: 1, updatedBy: 'A' },
      connectedTo: 'A',
      rect: { x: 780, y: 100, width: 320, height: 240 },
    });
    expect(store.getState().notes.novo).toMatchObject({ position: { x: 780, y: 100 } });
    expect(store.getState().edges).toEqual([{ a: 'A', b: 'novo' }]);
  });

  it('alteração de nota existente mantém a posição e limpa o conflito', () => {
    const store = createAppStore();
    store.getState().loadProject(snapshot);
    store.getState().setNoteConflict('plano', 'alterada por A');
    store.getState().upsertNote({ name: 'plano', content: 'novo', revision: 3, updatedBy: 'você' });
    expect(store.getState().notes.plano).toMatchObject({ content: 'novo', revision: 3, position: { x: 600, y: 20 }, conflict: null });
  });

  it('renomear nota troca chave, conexões e seleção preservando geometria e conflito', () => {
    const store = createAppStore();
    store.getState().loadProject(snapshot, { focusedTerminal: null, selectedNodes: ['plano'] });
    store.getState().setNoteConflict('plano', 'alterada por A');

    store.getState().renameNote('plano', { name: 'novo-plano', content: '# novo', revision: 3, updatedBy: 'vocês' });

    const state = store.getState();
    expect(state.notes.plano).toBeUndefined();
    expect(state.notes['novo-plano']).toMatchObject({ content: '# novo', position: { x: 600, y: 20 }, size: { width: 320, height: 240 }, conflict: 'alterada por A' });
    expect(state.edges).toEqual([{ a: 'A', b: 'novo-plano' }]);
    expect(state.selectedNodes).toEqual(['novo-plano']);
  });

  it('moveNode e resizeNode valem para notas; removeNote tira a nota e as conexões', () => {
    const store = createAppStore();
    store.getState().loadProject(snapshot);
    store.getState().moveNode('plano', { x: 0, y: 0 });
    store.getState().resizeNode('plano', { width: 400, height: 300 });
    expect(store.getState().notes.plano).toMatchObject({ position: { x: 0, y: 0 }, size: { width: 400, height: 300 } });
    store.getState().removeNote('plano');
    expect(store.getState().notes.plano).toBeUndefined();
    expect(store.getState().edges).toEqual([]);
  });

  it('note.removed tira a nota e as conexões dela', () => {
    const store = createAppStore();
    store.getState().loadProject(snapshot);
    expect(store.getState().notes.plano).toBeDefined();
    expect(store.getState().edges).toEqual([{ a: 'A', b: 'plano' }]);
    store.getState().applyEvent({ type: 'note.removed', name: 'plano' });
    expect(store.getState().notes.plano).toBeUndefined();
    expect(store.getState().edges).toEqual([]);
  });

  it('terminal.added desenha o nó na posição e conecta', () => {
    const store = createAppStore();
    store.getState().loadProject({ ...snapshot, terminals: [{ ...info('R'), resume: true, args: [], regente: true }], notes: [], edges: [] });
    store.getState().applyEvent({
      type: 'terminal.added',
      info: { ...info('S'), resume: true, args: [], regente: false },
      rect: { x: 780, y: 100, width: 640, height: 400 },
      connectedTo: 'R',
    });
    expect(store.getState().terminals.S).toMatchObject({ position: { x: 780, y: 100 }, size: { width: 640, height: 400 }, regente: false });
    expect(store.getState().edges).toEqual([{ a: 'R', b: 'S' }]);
    store.getState().applyEvent({ type: 'edge.removed', a: 'R', b: 'S' });
    expect(store.getState().edges).toEqual([]);
    store.getState().applyEvent({ type: 'edge.added', a: 'S', b: 'R' });
    expect(store.getState().edges).toHaveLength(1);
  });
});
