import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { SettingsStore } from '../src/settings.js';

const fileIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-settings-'));
  return { dir, file: join(dir, 'settings.json') };
};

describe('SettingsStore', () => {
  it('sem arquivo, padrões vazios; update grava e get lê de volta', () => {
    const { dir, file } = fileIn();
    const store = new SettingsStore({ file, log: silentLogger() });
    expect(store.get()).toEqual({ defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
    const settings = { defaultArgs: { claude: ['--dangerously-skip-permissions'], agy: [], codex: ['--no-daemon'] }, canvas: { snapToGrid: false, motion: 'minimal' as const } };
    expect(store.update(settings)).toEqual(settings);
    expect(new SettingsStore({ file, log: silentLogger() }).get()).toEqual(settings);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(settings);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('arquivo inválido vale padrões vazios', () => {
    const { file } = fileIn();
    writeFileSync(file, '{ quebrado');
    expect(new SettingsStore({ file, log: silentLogger() }).get()).toEqual({ defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
  });

  it('update recusa argumento reservado e não grava', () => {
    const { file } = fileIn();
    const store = new SettingsStore({ file, log: silentLogger() });
    expect(() => store.update({ defaultArgs: { claude: ['--resume'], agy: [] } })).toThrow(/Padrão do claude: O argumento --resume é controlado/);
    expect(store.get()).toEqual({ defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
  });
  it('lê configurações antigas preservando os argumentos existentes', () => {
    const { file } = fileIn();
    writeFileSync(file, JSON.stringify({ defaultArgs: { claude: ['--verbose'], agy: ['--effort', 'high'] } }));
    expect(new SettingsStore({ file, log: silentLogger() }).get()).toEqual({ defaultArgs: { claude: ['--verbose'], agy: ['--effort', 'high'], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
  });
});
