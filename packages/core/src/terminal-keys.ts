import { encodeWin32KeyEvent, type TerminalKey } from '@orquestra/shared';

type KeyDef = { code: string; key: string; ctrl?: boolean; vt: string; vtApplication?: string };

const KEYS: Record<TerminalKey, KeyDef> = {
  Enter: { code: 'Enter', key: 'Enter', vt: '\r' },
  Escape: { code: 'Escape', key: 'Escape', vt: '\x1b' },
  Tab: { code: 'Tab', key: 'Tab', vt: '\t' },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vt: '\x1b[A', vtApplication: '\x1bOA' },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vt: '\x1b[B', vtApplication: '\x1bOB' },
  CtrlC: { code: 'KeyC', key: 'c', ctrl: true, vt: '\x03' },
  Digit1: { code: 'Digit1', key: '1', vt: '1' },
  Digit2: { code: 'Digit2', key: '2', vt: '2' },
  Digit3: { code: 'Digit3', key: '3', vt: '3' },
};

/**
 * Bytes de uma tecla nomeada. Com o Codex em modo Win32 (DECSET 9001) vai o mesmo par pressionada/solta que a
 * interface do desktop envia; nos demais casos, a sequência VT comum (setas respeitam o modo de aplicação).
 */
export function encodeTerminalKey(key: TerminalKey, mode: { win32: boolean; applicationCursor: boolean }): string {
  const def = KEYS[key];
  if (mode.win32) {
    const event = { code: def.code, key: def.key, ctrlKey: Boolean(def.ctrl), shiftKey: false, altKey: false, metaKey: false };
    return encodeWin32KeyEvent(event, true) + encodeWin32KeyEvent(event, false);
  }
  return mode.applicationCursor && def.vtApplication ? def.vtApplication : def.vt;
}
