import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectFiles } from '../src/project-files.js';

afterEach(() => vi.restoreAllMocks());
describe('arquivos do projeto', () => {
  it('acompanha adições, alterações, remoções e arquivos novos sem Git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orq-files-'));
    for (const name of ['add.txt', 'edit.txt', 'remove.txt', 'delete.txt']) writeFileSync(join(root, name), 'one\ntwo\n');
    const files = new ProjectFiles(root);
    expect((await files.list('')).comparison).toBe('session');
    writeFileSync(join(root, 'add.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(root, 'edit.txt'), 'one\nchanged\n');
    writeFileSync(join(root, 'remove.txt'), 'one\n');
    unlinkSync(join(root, 'delete.txt'));
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const state = Object.fromEntries((await files.list('')).entries.map((entry) => [entry.name, entry]));
    expect(state['add.txt']).toMatchObject({ change: 'added', additions: 1, deletions: 0 });
    expect(state['edit.txt']).toMatchObject({ change: 'modified', additions: 1, deletions: 1 });
    expect(state['remove.txt']).toMatchObject({ change: 'removed', additions: 0, deletions: 1 });
    expect(state['delete.txt']).toMatchObject({ change: 'removed', deletions: 2 });
    expect(state['new.txt']?.change).toBe('added');
    expect((await files.read('edit.txt')).diff).toContain('+changed');
    expect((await files.list('')).entries.find((entry) => entry.name === 'delete.txt')?.change).toBe('removed');
  });
  it('Git considera mudanças staged e unstaged e preserva nomes com espaços', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orq-git-files-'));
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git(['init']);
    for (const name of ['add file.txt', 'edit.txt', 'remove.txt', 'deleted.txt']) writeFileSync(join(root, name), 'one\ntwo\n');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
    writeFileSync(join(root, 'add file.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(root, 'edit.txt'), 'one\nchanged\n');
    writeFileSync(join(root, 'remove.txt'), 'one\n');
    unlinkSync(join(root, 'deleted.txt'));
    git(['add', 'edit.txt']);
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const files = new ProjectFiles(root);
    const result = await files.list('');
    expect(result.comparison).toBe('git');
    const state = Object.fromEntries(result.entries.map((entry) => [entry.name, entry.change]));
    expect(state).toMatchObject({ 'add file.txt': 'added', 'edit.txt': 'modified', 'remove.txt': 'removed', 'deleted.txt': 'removed', 'new.txt': 'added' });
    expect((await files.read('deleted.txt')).diff).toContain('-two');
    expect((await files.read('edit.txt')).diff).toContain('+changed');
  });
  it('limita navegação ao projeto e trata arquivos binários e grandes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orq-safe-files-'));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(512 * 1024 + 1));
    mkdirSync(join(root, 'folder'));
    mkdirSync(join(root, 'node_modules'));
    const files = new ProjectFiles(root);
    await expect(files.read('../outside.txt')).rejects.toThrow(/dentro do projeto/);
    await expect(files.list('C:/Windows')).rejects.toThrow(/dentro do projeto/);
    expect((await files.read('binary.bin')).kind).toBe('binary');
    expect((await files.read('large.txt')).kind).toBe('large');
    expect((await files.list('')).entries.some((entry) => entry.name === 'node_modules')).toBe(false);
  });
});

describe('frequência das consultas ao Git', () => {
  const repository = () => {
    const root = mkdtempSync(join(tmpdir(), 'orq-git-cache-'));
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git(['init']);
    writeFileSync(join(root, 'tracked.txt'), 'one\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
    return root;
  };
  const changed = async (files: ProjectFiles) => (await files.list('')).entries.filter((entry) => entry.change !== 'none').map((entry) => entry.name).sort();

  it('dentro do prazo do cache, mudanças novas não disparam outro git status', async () => {
    const root = repository();
    const files = new ProjectFiles(root, { gitCacheMs: 60_000 });
    expect(await changed(files)).toEqual([]);
    writeFileSync(join(root, 'novo.txt'), 'novo\n');
    expect(await changed(files)).toEqual([]);
  });

  it('com cache zero, a mudança aparece na consulta seguinte', async () => {
    const root = repository();
    const files = new ProjectFiles(root, { gitCacheMs: 0 });
    expect(await changed(files)).toEqual([]);
    writeFileSync(join(root, 'novo.txt'), 'novo\n');
    expect(await changed(files)).toEqual(['novo.txt']);
  });

  it('o prazo padrão é de 10 s: o explorador consulta o Git no máximo a cada 10 s por projeto', async () => {
    const root = repository();
    const files = new ProjectFiles(root);
    expect(await changed(files)).toEqual([]);
    writeFileSync(join(root, 'novo.txt'), 'novo\n');
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(await changed(files)).toEqual([]);
  });
});
