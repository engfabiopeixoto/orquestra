import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnPty } from '../src/pty-session.js';
import { resolveExecutable } from '../src/resolve-exe.js';

describe('spawnPty', () => {
  it('roda um processo no ConPTY numa pasta com espaço e acento e recebe UTF-8', async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), 'orq ')), 'pasta ação');
    mkdirSync(cwd);
    const node = resolveExecutable('node');
    const pty = spawnPty({
      file: node.file,
      args: [...node.argsPrefix, '-e', 'process.stdout.write("olá " + process.cwd())'],
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
    let output = '';
    pty.onData((data) => (output += data));
    const code = await new Promise<number>((resolve) => pty.onExit(resolve));
    expect(code).toBe(0);
    expect(output).toContain('olá');
    expect(output).toContain('pasta ação');
  });
});
