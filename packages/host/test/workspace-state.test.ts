import { describe, expect, it } from 'vitest';
import { WorkspaceState } from '../src/workspace-state.js';

const descriptor = (name: string) => ({
  id: crypto.randomUUID(),
  name,
  agent: 'shell',
  cwd: 'C:/p',
  args: [],
  resume: true,
  agentSessionId: null,
  regente: false,
  persona: null,
  monitor: false,
});
const note = (name: string) => ({ id: crypto.randomUUID(), name, content: '', revision: 1, updatedBy: 'você' });

describe('WorkspaceState', () => {
  it('captura terminais, notas, conexões, layout e viewport', () => {
    const state = new WorkspaceState();
    state.place('A', { x: 10, y: 20, width: 500, height: 300 });
    state.setViewport({ x: 1, y: 2, zoom: 0.5 });
    const workspace = state.capture({ terminals: [descriptor('A')], notes: [note('n')], connections: [{ a: 'A', b: 'n' }] });
    expect(workspace.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(workspace.terminals[0]).toMatchObject({ name: 'A', position: { x: 10, y: 20 }, size: { width: 500, height: 300 } });
    // Nota sem posição recebida da interface: próximo espaço livre.
    expect(workspace.notes[0]).toMatchObject({ name: 'n', position: { x: 550, y: 80 }, size: { width: 320, height: 240 } });
    expect(workspace.connections).toEqual([{ a: 'A', b: 'n' }]);
  });

  it('renomear e esquecer movem o layout junto', () => {
    const state = new WorkspaceState({ layout: { A: { x: 0, y: 0, width: 1, height: 1 } } });
    state.rename('A', 'B');
    expect(state.rectOf('B')).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    state.forget('B');
    expect(state.layout()).toEqual({});
  });

  it('armazena e gerencia funções do projeto', () => {
    const state = new WorkspaceState({ personas: [{ name: 'base', text: 'Base.' }] });
    expect(state.personas()).toEqual([{ name: 'base', text: 'Base.' }]);
    expect(state.writePersona({ name: 'nova', text: 'Nova.' })).toEqual({ created: true });
    expect(state.writePersona({ name: 'nova', text: 'Atualizada.' })).toEqual({ created: false });
    expect(state.personas()).toEqual([
      { name: 'base', text: 'Base.' },
      { name: 'nova', text: 'Atualizada.' },
    ]);
    expect(state.removePersona('base')).toBe(true);
    expect(state.removePersona('inexistente')).toBe(false);
    expect(state.personas()).toEqual([{ name: 'nova', text: 'Atualizada.' }]);
  });

  it('recusa função com texto vazio ou nome com espaço', () => {
    const state = new WorkspaceState();
    expect(() => state.writePersona({ name: 'ok', text: '' })).toThrow(/Função inválida:.*texto.*vazio/);
    expect(() => state.writePersona({ name: 'com espaço', text: 'válido' })).toThrow(/Função inválida:.*sem espaço/);
  });

  it('captura inclui personas do projeto e campos regente/persona dos terminais', () => {
    const state = new WorkspaceState({ personas: [{ name: 'revisor', text: 'Revise.' }] });
    const terminalDesc = {
      ...descriptor('R'),
      regente: true,
      persona: 'revisor',
    };
    const workspace = state.capture({ terminals: [terminalDesc], notes: [], connections: [] });
    expect(workspace.personas).toEqual([{ name: 'revisor', text: 'Revise.' }]);
    expect(workspace.terminals[0]).toMatchObject({ name: 'R', regente: true, persona: 'revisor' });
  });

  it('agente fora do workspace (ex.: fake dos testes) não entra na captura', () => {
    const workspace = new WorkspaceState().capture({ terminals: [{ ...descriptor('X'), agent: 'fake' }], notes: [], connections: [] });
    expect(workspace.terminals).toEqual([]);
  });

  it('capture grava monitor do descritor', () => {
    const state = new WorkspaceState();
    const workspace = state.capture({
      terminals: [{ ...descriptor('A'), monitor: true }, { ...descriptor('B'), monitor: false }],
      notes: [],
      connections: [],
    });
    expect(workspace.terminals.map((t) => t.monitor)).toEqual([true, false]);
  });
});
