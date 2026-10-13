import { describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { OutputBus } from '../src/renderer/src/output-bus';
import { attachTerminal, runAttachTerminal, type TermLike } from '../src/renderer/src/terminal/attach';

function fakeTerm() {
  const writes: string[] = [];
  let dataListener: ((data: string) => void) | undefined;
  const term: TermLike & { writes: string[]; type(data: string): void; resets: number } = {
    writes,
    resets: 0,
    cols: 100,
    rows: 30,
    reset() {
      this.resets++;
    },
    write: (data) => void writes.push(data),
    onData: (listener) => {
      dataListener = listener;
      return { dispose: () => (dataListener = undefined) };
    },
    type: (data) => dataListener?.(data),
  };
  return term;
}

function fakeApi(bus: OutputBus) {
  const calls: Array<[string, unknown]> = [];
  const api: CommandApi = {
    command: (async (method: string, params: unknown) => {
      calls.push([method, params]);
      // Saída gerada antes do retrato já está nele: chega durante o pedido e deve ser ignorada.
      if (method === 'terminal.snapshot') {
        bus.publish('A', 'antes');
        return { data: 'RETRATO', cols: 100, rows: 30 };
      }
      return {};
    }) as CommandApi['command'],
  };
  return { api, calls };
}

describe('attachTerminal', () => {
  it('redimensiona antes de pedir o retrato e escreve o retrato num terminal limpo', async () => {
    const bus = new OutputBus();
    const term = fakeTerm();
    const { api, calls } = fakeApi(bus);
    let fitted = false;
    await attachTerminal({ name: 'A', term, fit: () => (fitted = true), api, bus });
    expect(fitted).toBe(true);
    expect(calls.map(([method]) => method)).toEqual(['terminal.resize', 'terminal.snapshot']);
    expect(calls[0]![1]).toEqual({ name: 'A', cols: 100, rows: 30 });
    expect(term.resets).toBe(1);
  });

  it('ignora a saída anterior ao retrato e mostra a posterior', async () => {
    const bus = new OutputBus();
    const term = fakeTerm();
    const { api } = fakeApi(bus);
    await attachTerminal({ name: 'A', term, fit: () => {}, api, bus });
    bus.publish('A', 'depois');
    expect(term.writes).toEqual(['RETRATO', 'depois']);
  });

  it('repassa o que se digita e para de ouvir ao desmontar', async () => {
    const bus = new OutputBus();
    const term = fakeTerm();
    const { api, calls } = fakeApi(bus);
    const detach = await attachTerminal({ name: 'A', term, fit: () => {}, api, bus });
    term.type('ls\r');
    expect(calls.at(-1)).toEqual(['terminal.input', { name: 'A', data: 'ls\r' }]);
    detach();
    bus.publish('A', 'ignorado');
    expect(term.writes).not.toContain('ignorado');
  });

  it('se o pedido de retrato falhar, a inscrição no OutputBus não vaza', async () => {
    const bus = new OutputBus();
    const term = fakeTerm();
    const api: CommandApi = {
      command: (async (method: string) => {
        if (method === 'terminal.snapshot') throw new Error('falha no retrato');
        return {};
      }) as CommandApi['command'],
    };
    await expect(attachTerminal({ name: 'A', term, fit: () => {}, api, bus })).rejects.toThrow('falha no retrato');
    expect(bus.has('A')).toBe(false);
  });

  it('OutputBus apaga o conjunto de ouvintes quando ele fica vazio', () => {
    const bus = new OutputBus();
    const unsubscribe = bus.subscribe('A', () => {});
    expect(bus.has('A')).toBe(true);
    unsubscribe();
    expect(bus.has('A')).toBe(false);
  });

  it('desmontar o nó no meio do attach não gera aviso falso de erro', async () => {
    let rejectSnapshot: ((err: Error) => void) | undefined;
    const api: CommandApi = {
      command: (async (method: string) => {
        if (method === 'terminal.snapshot') {
          return new Promise((_, reject) => {
            rejectSnapshot = reject;
          });
        }
        return {};
      }) as CommandApi['command'],
    };
    const bus = new OutputBus();
    const term = fakeTerm();
    const onError = vi.fn();
    const detach = runAttachTerminal({ name: 'A', term, fit: () => {}, api, bus, onError });
    detach();
    rejectSnapshot?.(new Error('desmontado'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onError).not.toHaveBeenCalled();
  });
});
