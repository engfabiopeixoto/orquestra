import type { IParser } from '@xterm/xterm';
import { encodeWin32KeyEvent } from '@orquestra/shared/win32-input';

export { encodeWin32KeyEvent };

function paramList(params: (number | number[])[]): number[] {
  return params.flatMap((value) => Array.isArray(value) ? value : [value]);
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
