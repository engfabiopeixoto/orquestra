import { randomUUID } from 'node:crypto';
import { canvasGroupSchema, expandGroupRects, fitGroupRects, GROUP_HEADER, GROUP_PADDING, groupContains, inferredGroupKind, memberKey, OrqError, positionSchema, sizeSchema, type CanvasGroup, type GroupElement, type GroupMember, type GroupRect, type HostParams } from '@orquestra/shared';

const clone = (group: CanvasGroup): CanvasGroup => ({ ...group, position: { ...group.position }, size: { ...group.size }, members: group.members.map((member) => ({ ...member })) });
const rectOf = (group: CanvasGroup): GroupRect => ({ ...group.position, ...group.size });

/** Pure layout ownership. It never creates connections or starts/stops agents. */
export class CanvasGroups {
  private items = new Map<string, CanvasGroup>();
  constructor(initial: CanvasGroup[] = []) { this.replace(initial); }
  list(): CanvasGroup[] { return [...this.items.values()].sort((a, b) => a.order - b.order).map(clone); }
  replace(groups: CanvasGroup[]): void { this.items = new Map(groups.map((group) => [group.id, clone(canvasGroupSchema.parse(group))])); }
  private require(id: string): CanvasGroup {
    const group = this.items.get(id);
    if (!group) throw new OrqError('NOT_FOUND', 'O grupo não existe neste workspace.');
    return group;
  }
  private resolve(members: GroupMember[], elements: GroupElement[]): GroupElement[] {
    const seen = new Set<string>();
    return members.map((member) => {
      const key = memberKey(member);
      if (seen.has(key)) throw new OrqError('USAGE', 'O mesmo elemento foi selecionado duas vezes.');
      seen.add(key);
      const element = elements.find((element) => memberKey(element) === key);
      if (!element) throw new OrqError('NOT_FOUND', 'Um dos elementos não existe neste workspace.');
      return element;
    });
  }
  private setRect(group: CanvasGroup, rect: GroupRect): CanvasGroup {
    if (!positionSchema.safeParse({ x: rect.x, y: rect.y }).success || !sizeSchema.safeParse({ width: rect.width, height: rect.height }).success) throw new OrqError('USAGE', 'A posição ou o tamanho do grupo é inválido.');
    return { ...group, position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } };
  }
  private changedRect(a: GroupRect, b: GroupRect): boolean { return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height; }

  create(input: HostParams<'group.create'>, elements: GroupElement[]): CanvasGroup {
    const selected = this.resolve(input.members, elements);
    const rect = fitGroupRects(selected.map((element) => element.rect), { ...input.position, width: 720, height: 520 });
    if (!selected.length) {
      // Frames stay behind nodes; keep a new empty frame's handle reachable.
      const obstacles = [...elements.map((element) => element.rect), ...this.list().map((group) => ({ ...group.position, width: group.size.width, height: GROUP_HEADER }))];
      for (let index = 0; index <= obstacles.length; index++) {
        const collisions = obstacles.filter((obstacle) => obstacle.x < rect.x + rect.width + GROUP_PADDING && obstacle.x + obstacle.width > rect.x - GROUP_PADDING && obstacle.y < rect.y + GROUP_HEADER + GROUP_PADDING && obstacle.y + obstacle.height > rect.y - GROUP_PADDING);
        if (!collisions.length) break;
        rect.y = Math.max(...collisions.map((obstacle) => obstacle.y + obstacle.height)) + GROUP_PADDING;
      }
    }
    const group = canvasGroupSchema.parse({ id: randomUUID(), title: input.title, color: input.color, kind: inferredGroupKind(input.members, input.kind), position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height }, members: [], locked: false, order: Math.max(-1, ...this.list().map((group) => group.order)) + 1 });
    this.items.set(group.id, group);
    this.assign(group.id, input.members, elements);
    return clone(this.require(group.id));
  }
  update({ id, ...changes }: HostParams<'group.update'>): void {
    this.items.set(id, canvasGroupSchema.parse({ ...this.require(id), ...changes }));
  }
  assign(id: string | null, members: GroupMember[], elements: GroupElement[]): void {
    this.resolve(members, elements);
    const target = id ? this.require(id) : null;
    const keys = new Set(members.map(memberKey));
    const next = this.list().map((group) => ({ ...group, members: group.members.filter((member) => !keys.has(memberKey(member))) }));
    if (target) {
      const destination = next.find((group) => group.id === id)!;
      destination.members.push(...members.map((member) => ({ ...member })));
      const expanded = expandGroupRects(rectOf(destination), this.resolve(destination.members, elements).map((element) => element.rect));
      if (target.locked && this.changedRect(rectOf(target), expanded)) throw new OrqError('USAGE', 'Desbloqueie o quadro para expandi-lo e receber esses elementos.');
      Object.assign(destination, this.setRect(destination, expanded));
    }
    for (const group of next) group.kind = inferredGroupKind(group.members, group.kind);
    this.replace(next);
  }
  validateAssignment(id: string, member: GroupMember, elements: GroupElement[]): void {
    new CanvasGroups(this.list()).assign(id, [member], elements);
  }
  move(id: string, position: { x: number; y: number }, elements: GroupElement[]): Array<{ name: string } & GroupRect> {
    const group = this.require(id);
    if (group.locked) throw new OrqError('USAGE', 'Desbloqueie o quadro antes de movê-lo.');
    const members = this.resolve(group.members, elements);
    const blocked = members.find((element) => element.locked);
    if (blocked) throw new OrqError('USAGE', `Desbloqueie ${blocked.name} para mover o grupo inteiro.`);
    const dx = position.x - group.position.x, dy = position.y - group.position.y;
    const moved = members.map((element) => ({ name: element.name, ...element.rect, x: element.rect.x + dx, y: element.rect.y + dy }));
    if (moved.some((rect) => !positionSchema.safeParse(rect).success)) throw new OrqError('USAGE', 'O deslocamento resulta em uma posição inválida.');
    const next = this.setRect(group, { ...position, ...group.size });
    this.items.set(id, next);
    return moved;
  }
  setMembers(id: string, members: GroupMember[], elements: GroupElement[]): void {
    const before = this.list();
    const group = this.require(id);
    try {
      this.assign(null, group.members, elements);
      this.assign(id, members, elements);
    } catch (error) { this.replace(before); throw error; }
  }
  resize(id: string, rect: GroupRect, elements: GroupElement[]): void {
    const group = this.require(id);
    if (group.locked) throw new OrqError('USAGE', 'Desbloqueie o quadro antes de redimensioná-lo.');
    const next = this.setRect(group, rect);
    const minimum = { width: 320, height: 200 };
    if (rect.width < minimum.width || rect.height < minimum.height || this.resolve(group.members, elements).some((element) => !groupContains(next, element.rect))) throw new OrqError('USAGE', 'O quadro precisa conter todos os seus elementos, com espaço para o título e as margens.');
    this.items.set(id, next);
  }
  fit(id: string, elements: GroupElement[]): void {
    const group = this.require(id);
    const rect = fitGroupRects(this.resolve(group.members, elements).map((element) => element.rect), rectOf(group));
    if (group.locked && this.changedRect(rectOf(group), rect)) throw new OrqError('USAGE', 'Desbloqueie o quadro antes de ajustá-lo.');
    this.items.set(id, this.setRect(group, rect));
  }
  remove(id: string): void { this.require(id); this.items.delete(id); }
  forget(id: string): void {
    for (const group of this.items.values()) {
      group.members = group.members.filter((member) => member.id !== id);
      group.kind = inferredGroupKind(group.members, group.kind);
    }
  }
  prune(elements: Array<GroupMember>): void {
    const valid = new Set(elements.map(memberKey));
    for (const group of this.items.values()) {
      group.members = group.members.filter((member) => valid.has(memberKey(member)));
      group.kind = inferredGroupKind(group.members, group.kind);
    }
  }
  expand(elements: GroupElement[]): void {
    const next = this.list().map((group) => {
      const rect = expandGroupRects(rectOf(group), this.resolve(group.members, elements).map((element) => element.rect));
      if (group.locked && this.changedRect(rectOf(group), rect)) throw new OrqError('USAGE', 'O elemento ultrapassa um quadro bloqueado. Desbloqueie o quadro ou retire o elemento do grupo.');
      return this.setRect(group, rect);
    });
    this.replace(next);
  }
}
