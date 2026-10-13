import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { RecentProjects } from '../src/recent-projects.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'orq-recent-')), 'recent.json');

describe('RecentProjects', () => {
  it('lista vazia sem arquivo; touch põe o projeto no topo e grava', () => {
    const path = file();
    const recent = new RecentProjects({ file: path, log: silentLogger() });
    expect(recent.list()).toEqual([]);
    recent.touch('C:\\proj\\alfa', new Date('2026-10-10T08:00:00Z'));
    recent.touch('C:\\proj\\beta', new Date('2026-10-10T09:00:00Z'));
    expect(recent.list().map((project) => project.name)).toEqual(['beta', 'alfa']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2);
  });

  it('reabrir o mesmo caminho (com outra caixa) só atualiza a data', () => {
    const recent = new RecentProjects({ file: file(), log: silentLogger() });
    recent.touch('C:\\proj\\alfa', new Date('2026-10-10T08:00:00Z'));
    recent.touch('C:\\proj\\beta', new Date('2026-10-10T09:00:00Z'));
    recent.touch('c:\\PROJ\\alfa', new Date('2026-10-10T10:00:00Z'));
    expect(recent.list()).toEqual([
      { dir: 'c:\\PROJ\\alfa', name: 'alfa', openedAt: '2026-10-10T10:00:00.000Z' },
      { dir: 'C:\\proj\\beta', name: 'beta', openedAt: '2026-10-10T09:00:00.000Z' },
    ]);
  });

  it('guarda no máximo o limite', () => {
    const recent = new RecentProjects({ file: file(), log: silentLogger(), limit: 2 });
    for (const name of ['a', 'b', 'c']) recent.touch(`C:\\${name}`);
    expect(recent.list().map((project) => project.name)).toEqual(['c', 'b']);
  });

  it('arquivo inválido vale lista vazia', () => {
    const path = file();
    writeFileSync(path, '[{"dir": 1}]');
    expect(new RecentProjects({ file: path, log: silentLogger() }).list()).toEqual([]);
  });
});
