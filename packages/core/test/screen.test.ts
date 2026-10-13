import { describe, expect, it } from 'vitest';
import { Screen } from '../src/screen.js';
import { ScreenWatcher } from '../src/screen-watcher.js';

describe('Screen', () => {
  it('o retrato reproduz o texto num terminal limpo do mesmo tamanho', async () => {
    const original = new Screen(40, 10);
    await original.write('\x1b[31mação\x1b[0m ✅\r\nlinha 2');
    const copy = new Screen(40, 10);
    await copy.write(original.serialize());
    expect(copy.text()).toBe(original.text());
  });

  it('devolve texto sem ANSI e sem linhas vazias no fim', async () => {
    const screen = new Screen(40, 10);
    await screen.write('\x1b[31mvermelho\x1b[0m\r\nação\r\n');
    expect(screen.text()).toBe('vermelho\nação');
  });

  it('tail devolve só as últimas linhas', async () => {
    const screen = new Screen(40, 10);
    await screen.write('a\r\nb\r\nc');
    expect(screen.tail(2)).toBe('b\nc');
  });

  it('visible devolve só a área visível, sem o histórico', async () => {
    const screen = new Screen(40, 3);
    await screen.write('antiga\r\n1\r\n2\r\n3');
    expect(screen.visible()).toBe('1\n2\n3');
  });
});

describe('ScreenWatcher', () => {
  const rules = [
    { pattern: /Interrupted/, signal: 'interrupted' as const },
    { pattern: /Requesting permission/, signal: 'waiting' as const },
  ];

  it('avisa só na borda de subida e mantém o conjunto visível', () => {
    const watcher = new ScreenWatcher(rules);
    expect(watcher.update('Requesting permission for: ls')).toEqual({ appeared: ['waiting'], visible: new Set(['waiting']) });
    expect(watcher.update('Requesting permission for: ls')).toEqual({ appeared: [], visible: new Set(['waiting']) });
    expect(watcher.update('nada')).toEqual({ appeared: [], visible: new Set() });
    expect(watcher.update('Interrupted · What should X do instead?').appeared).toEqual(['interrupted']);
  });
});
