/** Junta a saída de cada terminal e envia uma vez por intervalo: menos mensagens IPC para a interface. */
export class OutputBatcher {
  private readonly pending = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flushTo: (name: string, data: string) => void,
    private readonly intervalMs = 16,
  ) {}

  push(name: string, data: string): void {
    this.pending.set(name, (this.pending.get(name) ?? '') + data);
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const entries = [...this.pending];
    this.pending.clear();
    for (const [name, data] of entries) this.flushTo(name, data);
  }

  drop(name: string): void {
    this.pending.delete(name);
  }
}
