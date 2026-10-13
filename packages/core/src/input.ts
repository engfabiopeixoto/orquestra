import type { PtyProcess } from './pty-host.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const DEFAULT_SUBMIT_DELAY_MS = 150;

// O ConPTY descarta os marcadores de colagem; um CR no meio enviaria o prompt pela metade.
// LF (Ctrl+J) insere a quebra no campo de entrada sem enviar (testado no Claude Code e no agy).
export function encodePrompt(text: string): { body: string; submit: string } {
  const sanitized = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
  return { body: PASTE_START + sanitized.replace(/\r\n|\r|\n/g, '\n') + PASTE_END, submit: '\r' };
}

export async function writePrompt(
  pty: Pick<PtyProcess, 'write'>,
  text: string,
  opts: { encode?: (body: string) => string; submitDelayMs?: number } = {},
): Promise<void> {
  const { body, submit } = encodePrompt(text);
  pty.write(opts.encode ? opts.encode(body) : body);
  await new Promise((resolve) => setTimeout(resolve, opts.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS));
  pty.write(submit);
}

// Modo win32-input do ConPTY: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ (tecla pressionada e solta).
function win32Key(codeUnit: number): string {
  return `\x1b[0;0;${codeUnit};1;0;1_\x1b[0;0;${codeUnit};0;0;1_`;
}

export function encodeWithWin32(text: string, isUnsafe: (char: string) => boolean): string {
  let out = '';
  for (const char of text) {
    if (!isUnsafe(char)) {
      out += char;
      continue;
    }
    for (let index = 0; index < char.length; index++) out += win32Key(char.charCodeAt(index));
  }
  return out;
}
