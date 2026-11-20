import { OrqError } from '@orquestra/shared';

/** Coordena a subida paralela do núcleo para que comandos da interface aguardem o boot ou reinício. */
export class HostGate<T> {
  private instance: T | null = null;
  private pending: Promise<T | null> | null = null;

  beginStart(starting: Promise<T | null>): void {
    this.instance = null;
    const wrapped = starting.then(
      (value) => {
        if (this.pending === wrapped) {
          this.instance = value;
          this.pending = null;
        }
        return value;
      },
      (error) => {
        if (this.pending === wrapped) {
          this.pending = null;
        }
        throw error;
      },
    );
    this.pending = wrapped;
  }

  current(): T | null {
    return this.instance;
  }

  clear(): void {
    this.instance = null;
    this.pending = null;
  }

  async requireReady(): Promise<T> {
    if (this.instance) return this.instance;
    if (this.pending) {
      const started = await this.pending;
      if (started) return started;
    }
    throw new OrqError('APP_UNAVAILABLE', 'O núcleo do Orquestra não está rodando. Reinicie o app.');
  }

  async waitSettled(): Promise<T | null> {
    if (this.instance) return this.instance;
    return this.pending ? await this.pending : null;
  }
}
