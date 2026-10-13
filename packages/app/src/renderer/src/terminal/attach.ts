import type { CommandApi } from '../api';
import type { OutputBus } from '../output-bus';
import { outputKey } from '../workspace-context';

export type TermLike = {
  reset(): void;
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  readonly cols: number;
  readonly rows: number;
};

/**
 * Ordem fixa (spec, seção 3): ajustar, redimensionar o PTY, pedir o retrato e escrevê-lo num terminal limpo.
 * O retrato reposiciona o cursor de forma relativa e só vale num xterm limpo do mesmo tamanho.
 * A saída que chega antes do retrato já está nele e é descartada.
 */
export async function attachTerminal(deps: {
  name: string;
  term: TermLike;
  fit: () => void;
  api: CommandApi;
  bus: OutputBus;
  outputName?: string;
}): Promise<() => void> {
  deps.fit();
  await deps.api.command('terminal.resize', { name: deps.name, cols: deps.term.cols, rows: deps.term.rows });
  let live = false;
  const unsubscribe = deps.bus.subscribe(deps.outputName ?? deps.name, (data) => {
    if (live) deps.term.write(data);
  });
  const snapshot = await deps.api.command('terminal.snapshot', { name: deps.name }).catch((error: unknown) => {
    unsubscribe();
    throw error;
  });
  deps.term.reset();
  deps.term.write(snapshot.data);
  live = true;
  const input = deps.term.onData((data) => void deps.api.command('terminal.input', { name: deps.name, data }).catch(() => {}));
  return () => {
    unsubscribe();
    input.dispose();
  };
}

/** Executa attachTerminal protegendo contra falso erro se o nó for desmontado antes do término. */
export function runAttachTerminal(deps: {
  name: string;
  term: TermLike;
  fit: () => void;
  api: CommandApi;
  bus: OutputBus;
  onError: (message: string) => void;
  outputName?: string;
}): () => void {
  let detach: (() => void) | undefined;
  let disposed = false;
  void attachTerminal({ name: deps.name, term: deps.term, fit: deps.fit, api: deps.api, bus: deps.bus, outputName: deps.outputName ?? outputKey(deps.name) })
    .then((cleanup) => (disposed ? cleanup() : (detach = cleanup)))
    .catch((error: Error) => {
      if (!disposed) deps.onError(`Não foi possível mostrar ${deps.name}: ${error.message}`);
    });
  return () => {
    disposed = true;
    detach?.();
  };
}
