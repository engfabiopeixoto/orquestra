import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { emptyWorkspace, migrateWorkspace, workspaceSchema, type Workspace } from '../src/workspace.js';

const terminal = (name: string, id = crypto.randomUUID()) => ({
  id,
  name,
  agent: 'claude' as const,
  cwd: 'C:/proj',
  args: [],
  resume: true,
  agentSessionId: null,
  position: { x: 0, y: 0 },
  size: { width: 640, height: 400 },
});
const note = (name: string, id = crypto.randomUUID()) => ({
  id,
  name,
  content: '# Plano',
  revision: 1,
  updatedBy: 'você',
  position: { x: 700, y: 0 },
  size: { width: 320, height: 240 },
});
const workspace = (overrides: Partial<z.input<typeof workspaceSchema>> = {}): unknown => ({ ...emptyWorkspace(), ...overrides });

describe('migrateWorkspace', () => {
  it('projetos anteriores recebem grupos vazios e referências inválidas são recusadas', () => {
    const old = { ...emptyWorkspace() } as Record<string, unknown>;
    delete old.groups;
    expect(migrateWorkspace(old).groups).toEqual([]);
    const a = terminal('A');
    const group = { id: crypto.randomUUID(), title: 'Equipe', color: '#7aa7ff', kind: 'agents' as const, position: { x: -24, y: -72 }, size: { width: 720, height: 520 }, members: [{ kind: 'terminal' as const, id: a.id }], locked: false, order: 0 };
    expect(() => migrateWorkspace(workspace({ groups: [group] }))).toThrow(/membro inexistente/);
    expect(() => migrateWorkspace(workspace({ terminals: [a], groups: [group, { ...group, id: crypto.randomUUID() }] }))).toThrow(/mais de um grupo/);
  });
  it('aceita um workspace válido da versão 1', () => {
    const raw = workspace({ terminals: [terminal('A'), terminal('B')], notes: [note('plano')], connections: [{ a: 'A', b: 'plano' }] });
    expect(migrateWorkspace(raw)).toMatchObject(raw as object);
  });

  it('workspace antigo, sem regente/persona/personas, recebe os padrões', () => {
    const old = { ...emptyWorkspace(), terminals: [terminal('A')] } as Record<string, unknown>;
    delete old.personas;
    const migrated = migrateWorkspace(old);
    expect(migrated.personas).toEqual([]);
    expect(migrated.terminals[0]).toMatchObject({ regente: false, persona: null });
  });

  it('workspace antigo recebe monitor pelo tipo', () => {
    const raw = workspace({ terminals: [terminal('A'), { ...terminal('S'), agent: 'shell' as const }] });
    const migrated = migrateWorkspace(raw);
    expect(migrated.terminals.map((terminal) => terminal.monitor)).toEqual([true, false]);
  });

  it('recusa função repetida', () => {
    const raw = workspace({ personas: [{ name: 'p', text: 'a' }, { name: 'p', text: 'b' }] });
    expect(() => migrateWorkspace(raw)).toThrow(/personas\.1\.name: função repetida: p/);
  });

  it('recusa versão desconhecida', () => {
    expect(() => migrateWorkspace({ ...emptyWorkspace(), schemaVersion: 2 })).toThrow(/schemaVersion: versão 2 não suportada/);
  });

  it('junta todas as falhas numa mensagem só, cada uma com o caminho', () => {
    const raw = workspace({
      viewport: { x: 0, y: 0, zoom: 0 },
      terminals: [{ ...terminal('A'), size: { width: -1, height: 400 } }],
    });
    expect(() => migrateWorkspace(raw)).toThrow(/viewport\.zoom: .*; terminals\.0\.size\.width: /);
  });

  it('recusa nome repetido entre terminal e nota, e id repetido', () => {
    const id = crypto.randomUUID();
    const raw = workspace({ terminals: [terminal('A', id)], notes: [note('A', id)] });
    expect(() => migrateWorkspace(raw)).toThrow(/notes\.0\.name: nome repetido: A; notes\.0\.id: id repetido/);
  });

  it('recusa conexão com nó inexistente, com ele mesmo, repetida e entre duas notas', () => {
    const raw = workspace({
      terminals: [terminal('A')],
      notes: [note('n1'), note('n2')],
      connections: [
        { a: 'A', b: 'fantasma' },
        { a: 'A', b: 'A' },
        { a: 'A', b: 'n1' },
        { a: 'n1', b: 'A' },
        { a: 'n1', b: 'n2' },
      ],
    });
    const message = (() => {
      try {
        migrateWorkspace(raw);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/connections\.0: conexão com nó inexistente: fantasma/);
    expect(message).toMatch(/connections\.1: conexão do nó com ele mesmo: A/);
    expect(message).toMatch(/connections\.3: conexão repetida: n1 e A/);
    expect(message).toMatch(/connections\.4: conexão entre duas notas: n1 e n2/);
  });

  it('recusa números não finitos em posição', () => {
    const raw = workspace({ terminals: [{ ...terminal('A'), position: { x: Number.POSITIVE_INFINITY, y: 0 } }] });
    expect(() => migrateWorkspace(raw)).toThrow(/terminals\.0\.position\.x/);
  });
});
