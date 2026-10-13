import type { Logger } from './log.js';

/** Grava o workspace um tempo depois da última mudança; flush grava o que estiver pendente (ao fechar). */
export class WorkspaceSaver {
  private timer: NodeJS.Timeout | undefined;
  private pending = false;

  constructor(private readonly opts: { save: () => void; delayMs?: number; log: Logger }) {}

  schedule(): void {
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.delayMs ?? 1000);
  }

  flush(): void {
    clearTimeout(this.timer);
    if (!this.pending) return;
    this.pending = false;
    try {
      this.opts.save();
    } catch (error) {
      this.opts.log.warn({ err: error }, 'não foi possível gravar o workspace');
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.pending = false;
  }
}
