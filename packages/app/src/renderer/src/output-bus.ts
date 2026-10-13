type Listener = (data: string) => void;

/** Saída dos terminais por nome: vai direto aos xterm, sem passar pelo estado do React. */
export class OutputBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(name: string, listener: Listener): () => void {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(name, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(name);
    };
  }

  has(name: string): boolean {
    return this.listeners.has(name);
  }

  publish(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener(data);
  }
}

export const outputBus = new OutputBus();
