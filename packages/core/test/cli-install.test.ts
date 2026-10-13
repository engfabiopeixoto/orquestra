import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCli, spaceFreePath } from '../src/cli-install.js';

describe('installCli', () => {
  it('copia o orq e cria orq.cmd e orq para PowerShell e Git Bash', () => {
    const source = join(mkdtempSync(join(tmpdir(), 'orq-src-')), 'orq.mjs');
    writeFileSync(source, 'console.log(1)');
    const binDir = mkdtempSync(join(tmpdir(), 'orq-bin-'));
    const installed = installCli({ script: source, binDir });
    expect(readFileSync(join(binDir, 'orq.mjs'), 'utf8')).toBe('console.log(1)');
    expect(readFileSync(join(binDir, 'orq.cmd'), 'utf8')).toContain('orq.mjs');
    expect(existsSync(join(binDir, 'orq'))).toBe(true);
    expect(installed.script).not.toMatch(/[\s\\]/);
  });

  it('troca um caminho com espaço pelo nome curto 8.3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq com espaço '));
    const short = spaceFreePath(dir);
    expect(short).not.toMatch(/\s/);
    expect(existsSync(short)).toBe(true);
  });
});
