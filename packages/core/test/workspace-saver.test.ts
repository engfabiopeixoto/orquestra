import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/log.js';
import { WorkspaceSaver } from '../src/workspace-saver.js';

describe('WorkspaceSaver', () => {
  it('agrupa mudanças seguidas numa gravação só, depois do atraso', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = new WorkspaceSaver({ save, delayMs: 1000, log: silentLogger() });
    saver.schedule();
    vi.advanceTimersByTime(600);
    saver.schedule();
    vi.advanceTimersByTime(600);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('flush grava na hora o que estava pendente, e não grava sem pendência', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = new WorkspaceSaver({ save, delayMs: 1000, log: silentLogger() });
    saver.flush();
    expect(save).not.toHaveBeenCalled();
    saver.schedule();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('falha ao gravar vai para o log e não derruba quem chamou', () => {
    const warn = vi.fn();
    const log = { ...silentLogger(), warn } as unknown as ReturnType<typeof silentLogger>;
    const saver = new WorkspaceSaver({ save: () => { throw new Error('disco cheio'); }, log });
    saver.schedule();
    expect(() => saver.flush()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'não foi possível gravar o workspace');
  });
});
