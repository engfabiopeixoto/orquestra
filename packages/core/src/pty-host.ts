import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';

export type PtySpawnSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
};

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  /** Falha ao escrever (por exemplo, o processo morrendo no meio da escrita). Sem ouvinte, a falha é descartada. */
  onError(cb: (error: Error) => void): void;
  /** Encerra e espera a saída (até 3 s): sair com o ConPTY fechando trava o process.exit no Windows. */
  kill(): Promise<void>;
}

export interface PtyHost {
  spawn(spec: PtySpawnSpec): PtyProcess;
}

const EXIT_WAIT_MS = 3000;

/**
 * O node-pty no Windows não ouve erros do pipe de entrada: escrever enquanto o processo morre dá EAGAIN
 * e, sem ouvinte, vira exceção não tratada que derruba o núcleo. O pipe só é acessível pelo campo interno.
 */
function inputPipe(proc: pty.IPty): EventEmitter | undefined {
  const pipe = (proc as unknown as { _agent?: { inSocket?: unknown } })._agent?.inSocket;
  return pipe instanceof EventEmitter ? pipe : undefined;
}

export const nodePtyHost: PtyHost = {
  spawn(spec) {
    const proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 40,
      cwd: spec.cwd,
      env: spec.env,
      useConpty: true,
      // ConPTY do node-pty (conpty.dll + OpenConsole.exe), não o do sistema: o do Windows 10 conta "❯"
      // como 2 colunas e desloca o texto digitado no prompt do Claude (letras sobrando na tela).
      useConptyDll: true,
    });
    const errors = new EventEmitter<{ error: [Error] }>();
    // Ouvinte fixo: mesmo sem quem ouça, a falha não pode virar exceção não tratada.
    inputPipe(proc)?.on('error', (error: Error) => errors.listenerCount('error') > 0 && errors.emit('error', error));
    let exited = false;
    const exitedPromise = new Promise<void>((resolve) =>
      proc.onExit(() => {
        exited = true;
        resolve();
      }),
    );
    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      onData: (cb) => void proc.onData(cb),
      onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
      onError: (cb) => void errors.on('error', cb),
      kill: async () => {
        if (exited) return;
        // O kill do node-pty 1.1 no Windows não mata o processo (o agente auxiliar falha com
        // "AttachConsole failed"): encerramos a árvore inteira com taskkill e esperamos a saída.
        // Assíncrono para não congelar quem chama; um erro (processo já saiu) é ignorado.
        await new Promise<void>((resolve) =>
          execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve()),
        );
        await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS))]);
      },
    };
  },
};
