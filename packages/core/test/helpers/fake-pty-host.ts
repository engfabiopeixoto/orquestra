import type { PtyHost, PtySpawnSpec } from '../../src/pty-host.js';
import { FakePty } from './fake-pty.js';

export class FakePtyHost implements PtyHost {
  readonly spawned: Array<{ spec: PtySpawnSpec; pty: FakePty }> = [];

  spawn(spec: PtySpawnSpec): FakePty {
    const pty = new FakePty();
    this.spawned.push({ spec, pty });
    return pty;
  }

  last(): FakePty {
    const entry = this.spawned.at(-1);
    if (!entry) throw new Error('Nenhum PTY criado.');
    return entry.pty;
  }
}
