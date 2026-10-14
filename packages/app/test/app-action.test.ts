import { describe, expect, it, vi } from 'vitest';
import { APP_ACTIONS } from '../src/shared/app-action';
import { appShortcut, handleAppAction, isAppAction } from '../src/main/app-action';

const key = (overrides: Partial<Parameters<typeof appShortcut>[0]> = {}) => ({ type: 'keyDown', key: '', control: false, shift: false, alt: false, meta: false, ...overrides });

describe('isAppAction', () => {
  it('aceita só as quatro ações do menu', () => {
    expect([...APP_ACTIONS]).toEqual(['open-logs', 'reload', 'devtools', 'quit']);
    for (const action of APP_ACTIONS) expect(isAppAction(action)).toBe(true);
    for (const value of ['shell', '', 'Quit', null, undefined, 7, {}]) expect(isAppAction(value)).toBe(false);
  });
});

describe('appShortcut', () => {
  it('Ctrl+Shift+F5 recarrega e F12 abre as ferramentas, sem depender do menu', () => {
    expect(appShortcut(key({ key: 'F5', control: true, shift: true }))).toBe('reload');
    expect(appShortcut(key({ key: 'F12' }))).toBe('devtools');
  });
  it('ignora teclas soltas, Ctrl+R (do terminal), Ctrl+Shift+I e combinações com Alt', () => {
    expect(appShortcut(key({ key: 'F5' }))).toBeNull();
    expect(appShortcut(key({ key: 'r', control: true }))).toBeNull();
    expect(appShortcut(key({ key: 'I', control: true, shift: true }))).toBeNull();
    expect(appShortcut(key({ key: 'F12', alt: true }))).toBeNull();
    expect(appShortcut(key({ type: 'keyUp', key: 'F12' }))).toBeNull();
  });
});

describe('handleAppAction', () => {
  const deps = () => ({ openLogs: vi.fn(), reload: vi.fn(), toggleDevTools: vi.fn(), quit: vi.fn(), warn: vi.fn() });

  it('despacha cada ação para a dependência correspondente', () => {
    const d = deps();
    handleAppAction('open-logs', d); handleAppAction('reload', d); handleAppAction('devtools', d); handleAppAction('quit', d);
    expect(d.openLogs).toHaveBeenCalledTimes(1);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.toggleDevTools).toHaveBeenCalledTimes(1);
    expect(d.quit).toHaveBeenCalledTimes(1);
  });

  it('rejeita ação desconhecida, registra e não executa nada', () => {
    const d = deps();
    expect(handleAppAction('format-disk', d)).toBe(false);
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('format-disk'));
    expect(d.openLogs).not.toHaveBeenCalled();
    expect(d.quit).not.toHaveBeenCalled();
  });
});
