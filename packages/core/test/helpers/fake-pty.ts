import type { PtyProcess } from '../../src/pty-host.js';

export class FakePty implements PtyProcess {
  readonly pid = 1;
  readonly written: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb);
  }
  onExit(cb: (code: number) => void): void {
    this.exitListeners.push(cb);
  }
  onError(cb: (error: Error) => void): void {
    this.errorListeners.push(cb);
  }
  async kill(): Promise<void> {
    this.emitExit(0);
  }
  emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data);
  }
  emitError(error: Error): void {
    for (const cb of this.errorListeners) cb(error);
  }
  emitExit(code: number): void {
    for (const cb of this.exitListeners) cb(code);
  }
}
