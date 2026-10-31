import type { IParser } from '@xterm/xterm';

type CodexKeyEvent = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

const virtualKeys: Record<string, number> = {
  Enter: 0x0d, Escape: 0x1b, Tab: 0x09, Space: 0x20, Backspace: 0x08,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Delete: 0x2e,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12,
};
const scanCodes: Record<string, number> = {
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Enter: 0x1c, Escape: 0x01, Tab: 0x0f, Space: 0x39, Backspace: 0x0e,
  ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4b, ArrowRight: 0x4d,
};
const enhancedKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete']);

function paramList(params: (number | number[])[]): number[] {
  return params.flatMap((value) => Array.isArray(value) ? value : [value]);
}

/** Codifica eventos DOM no formato Win32 INPUT_RECORD usado por ConPTY. */
export function encodeWin32KeyEvent(event: CodexKeyEvent, keyDown: boolean): string {
  let vk = virtualKeys[event.code];
  if (vk === undefined && /^Key[A-Z]$/.test(event.code)) vk = event.code.charCodeAt(3);
  if (vk === undefined && /^Digit[0-9]$/.test(event.code)) vk = event.code.charCodeAt(5);
  if (vk === undefined) vk = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0;
  const scan = scanCodes[event.code] ?? 0;
  let unicode = event.key.length === 1 ? event.key.codePointAt(0)! : 0;
  if (event.ctrlKey && !event.altKey && !event.metaKey && /^[A-Za-z]$/.test(event.key)) unicode = event.key.toUpperCase().charCodeAt(0) - 0x40;
  if (event.key === 'Enter') unicode = event.ctrlKey ? 0x0a : 0x0d;
  else if (event.key === 'Backspace') unicode = event.ctrlKey ? 0x7f : 0x08;
  let control = (event.shiftKey ? 0x10 : 0) | (event.ctrlKey ? 0x08 : 0) | (event.altKey ? 0x02 : 0);
  if (enhancedKeys.has(event.code)) control |= 0x100;
  return `\x1b[${vk};${scan};${unicode};${keyDown ? 1 : 0};${control};1_`;
}

/** Acompanha DECSET 9001 e deixa seleção/scroll local do Codex sob controle do xterm. */
export function installCodexInputMode(parser: Pick<IParser, 'registerCsiHandler'>, mode: { win32Input: boolean }): void {
  const trackMode = (params: (number | number[])[], enabled: boolean): boolean => {
    const modes = paramList(params);
    if (modes.includes(9001)) mode.win32Input = enabled;
    // O Codex recebe mouse tracking, mas o xterm mantém o modo de seleção local.
    return modes.some((entry) => [1000, 1002, 1003, 1006].includes(entry));
  };
  parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => trackMode(params, true));
  parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => trackMode(params, false));
}
