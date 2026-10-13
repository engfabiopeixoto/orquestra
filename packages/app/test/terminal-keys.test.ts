import { describe, expect, it } from 'vitest';
import { terminalKeyAction } from '../src/renderer/src/terminal/keys';

const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, type = 'keydown') => ({
  type,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('terminalKeyAction', () => {
  it('Ctrl+V e Ctrl+Shift+V colam texto (como no Windows Terminal), em vez de mandar ^V ao agente', () => {
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true }), false)).toBe('paste');
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true, shiftKey: true }), true)).toBe('paste');
  });

  it('Alt+V segue para o agente (o Claude Code cola imagem com ele no Windows)', () => {
    expect(terminalKeyAction(key('KeyV', { altKey: true }), false)).toBe('pass');
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true, altKey: true }), false)).toBe('pass');
  });

  it('Ctrl+C copia só com seleção; sem seleção é a interrupção do agente', () => {
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), true)).toBe('copy');
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), false)).toBe('pass');
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true, shiftKey: true }), true)).toBe('copy');
  });

  it('só o keydown decide; as outras fases e as demais teclas passam', () => {
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true }, 'keyup'), false)).toBe('pass');
    expect(terminalKeyAction(key('KeyR', { ctrlKey: true }), false)).toBe('pass');
    expect(terminalKeyAction(key('KeyI', { ctrlKey: true, shiftKey: true }), false)).toBe('pass');
  });

  it('Ctrl+Shift+I segue para o terminal em vez de ser interceptado', () => {
    expect(terminalKeyAction(key('KeyI', { ctrlKey: true, shiftKey: true }), false)).toBe('pass');
  });
});
