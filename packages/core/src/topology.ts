import { OrqError } from '@orquestra/shared';

export type NodeKind = 'terminal' | 'note' | 'portal';

export class Topology {
  private readonly kinds = new Map<string, NodeKind>();
  private readonly links = new Map<string, Set<string>>();

  add(name: string, kind: NodeKind): void {
    if (this.kinds.has(name)) throw new OrqError('USAGE', `Já existe um nó chamado ${name}. Escolha outro nome.`);
    this.kinds.set(name, kind);
    this.links.set(name, new Set());
  }

  remove(name: string): void {
    for (const neighbor of this.links.get(name) ?? []) this.links.get(neighbor)?.delete(name);
    this.links.delete(name);
    this.kinds.delete(name);
  }

  rename(oldName: string, newName: string): void {
    const kind = this.kinds.get(oldName);
    if (!kind) throw new OrqError('NOT_FOUND', `${oldName} não existe no canvas.`);
    if (this.kinds.has(newName)) throw new OrqError('USAGE', `Já existe um nó chamado ${newName}. Escolha outro nome.`);
    const neighbors = this.links.get(oldName) ?? new Set<string>();
    for (const neighbor of neighbors) {
      const set = this.links.get(neighbor)!;
      set.delete(oldName);
      set.add(newName);
    }
    this.kinds.delete(oldName);
    this.links.delete(oldName);
    this.kinds.set(newName, kind);
    this.links.set(newName, neighbors);
  }

  kindOf(name: string): NodeKind | undefined {
    return this.kinds.get(name);
  }

  connect(a: string, b: string): void {
    this.require(a);
    this.require(b);
    if (a === b) throw new OrqError('USAGE', 'Não dá para conectar um nó a ele mesmo.');
    if ((this.kinds.get(a) === 'portal' && this.kinds.get(b) !== 'terminal') || (this.kinds.get(b) === 'portal' && this.kinds.get(a) !== 'terminal')) throw new OrqError('USAGE', 'Conecte o navegador a um terminal de agente.');
    if (this.kinds.get(a) === 'note' && this.kinds.get(b) === 'note') throw new OrqError('USAGE', 'Não dá para conectar duas notas.');
    this.links.get(a)!.add(b);
    this.links.get(b)!.add(a);
  }

  disconnect(a: string, b: string): void {
    this.links.get(a)?.delete(b);
    this.links.get(b)?.delete(a);
  }

  isConnected(a: string, b: string): boolean {
    return this.links.get(a)?.has(b) ?? false;
  }

  neighbors(name: string, kind?: NodeKind): string[] {
    return [...(this.links.get(name) ?? [])].filter((neighbor) => !kind || this.kinds.get(neighbor) === kind).sort();
  }

  edges(): Array<{ a: string; b: string }> {
    const pairs: Array<{ a: string; b: string }> = [];
    for (const [name, neighbors] of this.links) for (const other of neighbors) if (name < other) pairs.push({ a: name, b: other });
    const key = (pair: { a: string; b: string }) => `${pair.a}\u0000${pair.b}`;
    return pairs.sort((x, y) => (key(x) < key(y) ? -1 : 1));
  }

  private require(name: string): void {
    if (!this.kinds.has(name)) throw new OrqError('NOT_FOUND', `${name} não existe no canvas.`);
  }
}
