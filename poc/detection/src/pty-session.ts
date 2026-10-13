import * as pty from 'node-pty';

export type PtySpawnSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
};

export interface PtySession {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export function spawnPty(spec: PtySpawnSpec): PtySession {
  const proc = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: spec.cols ?? 120,
    rows: spec.rows ?? 40,
    cwd: spec.cwd,
    env: spec.env,
    useConpty: true,
  });
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
    onData: (cb) => void proc.onData(cb),
    onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
  };
}
