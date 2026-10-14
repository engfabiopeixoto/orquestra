import { describe, expect, it } from 'vitest';
import { agyAdapter } from '../src/adapters/agy.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
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

  it('detecta linhas novas por turno em histórico curto e ignora repaint na mesma posição', () => {
    const watcher = new ScreenWatcher([
      { pattern: /^  Worked for \d+s • \d{2}:\d{2}$/, signal: 'done' as const, scope: 'new-occurrence' as const },
      { pattern: /^■ Conversation interrupted$/, signal: 'interrupted' as const, scope: 'new-occurrence' as const },
    ]);
    const history = Array.from({ length: 16 }, (_, index) => `linha ${index}`).join('\n');
    const firstFooter = `${history}\n  Worked for 2s • 05:54`;
    watcher.beginTurn(firstFooter);
    expect(watcher.update(firstFooter).appeared).toEqual([]);
    // O buffer curto substitui o rodapé anterior: a quantidade de correspondências continua em 1.
    expect(watcher.update(`${history}\n  Worked for 1s • 17:19`).appeared).toEqual(['done']);

    watcher.beginTurn('› próxima solicitação\n■ Conversation interrupted\nrodapé');
    expect(watcher.update('› próxima solicitação\n■ Conversation interrupted\nrodapé').appeared).toEqual([]);
    expect(watcher.update('› próxima solicitação\n■ Conversation interrupted\nrodapé').appeared).toEqual([]);
    expect(watcher.update('› próxima solicitação\nrodapé\n■ Conversation interrupted').appeared).toEqual([]);
  });

  it('reconhece um segundo marcador depois de uma nova linha de base por turno', () => {
    const watcher = new ScreenWatcher([
      { pattern: /^■ Conversation interrupted$/, signal: 'interrupted' as const, scope: 'new-occurrence' as const },
    ]);
    watcher.beginTurn('prompt 1');
    expect(watcher.update('prompt 1\n■ Conversation interrupted').appeared).toEqual(['interrupted']);
    watcher.beginTurn('prompt 2');
    expect(watcher.update('prompt 2\n■ Conversation interrupted').appeared).toEqual(['interrupted']);
  });

  it('ignora rodapés e marcadores antigos deslocados por 1, 3 ou 10 linhas', () => {
    const cases = [
      { rule: codexAdapter.screenRules.find((entry) => entry.signal === 'turn-end')!, line: '  Worked for 3s • 18:38' },
      { rule: codexAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '■ Conversation interrupted' },
      { rule: claudeAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '  ⎿  Interrupted · What should Claude do instead?' },
      { rule: agyAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '  ⎿  Interrupted · What should Antigravity CLI do instead?' },
    ];

    for (const { rule, line } of cases) {
      for (const shift of [1, 3, 10]) {
        const watcher = new ScreenWatcher([rule]);
        const base = [...Array.from({ length: 12 }, (_, index) => `texto ${index}`), line].join('\n');
        watcher.beginTurn(base);
        expect(watcher.update(base).appeared, `${rule.signal}: baseline`).toEqual([]);
        const shifted = [...Array.from({ length: 12 - shift }, (_, index) => `texto ${index + shift}`), line].join('\n');
        expect(watcher.update(shifted).appeared, `${rule.signal}: shift ${shift}`).toEqual([]);
        expect(watcher.update(shifted).appeared, `${rule.signal}: repaint ${shift}`).toEqual([]);
      }
    }
  });

  it('reconhece nova ocorrência quando a antiga sai em um update e a nova entra no seguinte', () => {
    const cases = [
      { rule: codexAdapter.screenRules.find((entry) => entry.signal === 'turn-end')!, line: '  Worked for 3s • 18:38' },
      { rule: codexAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '■ Conversation interrupted' },
      { rule: claudeAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '  ⎿  Interrupted · What should Claude do instead?' },
      { rule: agyAdapter.screenRules.find((entry) => entry.signal === 'interrupted')!, line: '  ⎿  Interrupted · What should Antigravity CLI do instead?' },
    ];

    for (const { rule, line } of cases) {
      const watcher = new ScreenWatcher([rule]);
      const base = `› prompt\n${line}`;
      watcher.beginTurn(base);
      expect(watcher.update(base).appeared).toEqual([]);
      expect(watcher.update('› prompt\nsem marcador').appeared).toEqual([]);
      expect(watcher.update(`› prompt\n${line}`).appeared).toEqual([rule.signal]);
    }
  });

  it('reconhece dois Ctrl+C consecutivos após o marcador anterior sair do buffer', () => {
    const line = '■ Conversation interrupted';
    const watcher = new ScreenWatcher([
      { pattern: /^■ Conversation interrupted$/, signal: 'interrupted' as const, scope: 'new-occurrence' as const },
    ]);
    watcher.beginTurn('› pedido 1');
    expect(watcher.update(`› pedido 1\n${line}`).appeared).toEqual(['interrupted']);
    watcher.beginTurn(`› pedido 2\n${line}`);
    expect(watcher.update(`› pedido 2\n${line}`).appeared).toEqual([]);
    expect(watcher.update('› pedido 2').appeared).toEqual([]);
    expect(watcher.update(`› pedido 2\n${line}`).appeared).toEqual(['interrupted']);
  });
});
