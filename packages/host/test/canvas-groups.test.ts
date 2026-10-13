import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { groupContains, groupDropTarget, type GroupElement } from '@orquestra/shared';
import { CanvasGroups } from '../src/canvas-groups.js';

const element = (name: string, overrides: Partial<GroupElement> = {}): GroupElement => ({ kind: 'terminal', id: randomUUID(), name, rect: { x: 100, y: 100, width: 640, height: 400 }, locked: false, ...overrides });
const input = (members: GroupElement[] = [], x = 0) => ({ title: 'Equipe', color: '#7aa7ff', kind: 'agents' as const, members: members.map(({ kind, id }) => ({ kind, id })), position: { x, y: 0 } });

describe('quadros do canvas', () => {
  it('cria um quadro ao redor dos membros com espaço para o título e infere grupos mistos', () => {
    const elements = [element('A'), element('nota', { kind: 'note', rect: { x: 800, y: 100, width: 320, height: 240 } })];
    const groups = new CanvasGroups();
    const group = groups.create(input(elements), elements);
    expect(group.kind).toBe('mixed');
    expect(group.members).toHaveLength(2);
    expect(elements.every((element) => groupContains(group, element.rect))).toBe(true);
  });
  it('mover desloca apenas membros; bloquear um membro recusa a operação inteira', () => {
    const a = element('A'), b = element('B', { rect: { x: 800, y: 100, width: 640, height: 400 } });
    const groups = new CanvasGroups();
    const group = groups.create(input([a]), [a, b]);
    const origin = group.position;
    const moved = groups.move(group.id, { x: origin.x + 200, y: origin.y + 50 }, [a, b]);
    expect(moved).toEqual([{ name: 'A', x: 300, y: 150, width: 640, height: 400 }]);
    const before = groups.list();
    expect(() => groups.move(group.id, { x: 999, y: 999 }, [{ ...a, locked: true }, b])).toThrow(/Desbloqueie A/);
    expect(groups.list()).toEqual(before);
  });
  it('associar transfere o elemento e desagrupar preserva a identidade e geometria dos elementos', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    const first = groups.create(input([a]), [a]);
    const second = groups.create(input([], 2000), [a]);
    groups.assign(second.id, [{ kind: a.kind, id: a.id }], [a]);
    expect(groups.list().find((group) => group.id === first.id)?.members).toEqual([]);
    expect(groups.list().find((group) => group.id === second.id)?.members).toHaveLength(1);
    groups.remove(second.id);
    expect(a.rect).toEqual({ x: 100, y: 100, width: 640, height: 400 });
  });
  it('uma transferência que exige expandir um quadro bloqueado mantém a associação original', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    groups.create(input([a]), [a]);
    const target = groups.create(input([], 2000), [a]);
    groups.update({ id: target.id, locked: true });
    const before = groups.list();
    expect(() => groups.assign(target.id, [{ kind: a.kind, id: a.id }], [a])).toThrow(/Desbloqueie o quadro/);
    expect(groups.list()).toEqual(before);
    expect(() => groups.setMembers(target.id, [{ kind: a.kind, id: a.id }], [a])).toThrow();
    expect(groups.list()).toEqual(before);
  });
  it('redimensionar não encolhe sobre membros nem os desloca; ajustar calcula o quadro mínimo', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    const group = groups.create(input([a]), [a]);
    expect(() => groups.resize(group.id, { ...group.position, width: 320, height: 200 }, [a])).toThrow(/conter todos/);
    groups.resize(group.id, { ...group.position, width: 1200, height: 900 }, [a]);
    groups.fit(group.id, [a]);
    expect(groups.list()[0]?.size).toEqual(group.size);
    expect(a.rect.x).toBe(100);
  });
  it('IDs mantêm associação ao renomear; referências removidas são limpas sem apagar quadros vazios', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    const group = groups.create(input([a]), [a]);
    groups.move(group.id, { x: 200, y: 100 }, [{ ...a, name: 'renomeado' }]);
    expect(groups.list()[0]?.members[0]?.id).toBe(a.id);
    groups.forget(a.id);
    expect(groups.list()).toHaveLength(1);
    expect(groups.list()[0]?.members).toEqual([]);
  });
  it('valida IDs desconhecidos e duplicados sem criar um quadro parcial', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    expect(() => groups.create(input([a]), [])).toThrow(/não existe/);
    expect(() => groups.create(input([a, a]), [a])).toThrow(/duas vezes/);
    expect(groups.list()).toEqual([]);
  });
  it('destino de arraste usa o centro na área útil e prioriza o quadro à frente', () => {
    const groups = new CanvasGroups();
    const first = groups.create(input(), []);
    const second = groups.create(input(), []);
    groups.move(second.id, first.position, []); // Deliberate overlap after placing a free header.
    expect(groupDropTarget(groups.list(), { x: 30, y: 70, width: 100, height: 100 })).toBe(second.id);
    expect(groupDropTarget(groups.list(), { x: 30, y: 0, width: 10, height: 10 })).toBeNull();
    expect(first.id).not.toBe(second.id);
  });
  it('um grupo vazio nasce com o cabeçalho fora dos elementos e dos títulos existentes', () => {
    const a = element('A');
    const groups = new CanvasGroups();
    const first = groups.create({ ...input(), position: { x: 100, y: 150 } }, [a]);
    expect(first.position.y).toBeGreaterThan(a.rect.y + a.rect.height);
    const second = groups.create({ ...input(), position: first.position }, [a]);
    expect(second.position.y).toBeGreaterThan(first.position.y + 48);
  });
});
