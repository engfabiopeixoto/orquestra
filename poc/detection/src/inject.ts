import type { PtySession } from './pty-session.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function encodePrompt(text: string, mode: 'bracketed' | 'plain'): { body: string; submit: string } {
  const sanitized = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
  if (mode === 'plain') {
    if (/\r|\n/.test(sanitized)) throw new Error('Prompt com várias linhas exige o modo bracketed.');
    return { body: sanitized, submit: '\r' };
  }
  // O ConPTY descarta os marcadores de colagem; um CR no meio enviaria o prompt pela metade.
  // LF (Ctrl+J) insere a quebra no campo de entrada sem enviar.
  return { body: PASTE_START + sanitized.replace(/\r\n|\r|\n/g, '\n') + PASTE_END, submit: '\r' };
}

// O Enter vai separado: várias TUIs descartam o Enter que chega no mesmo bloco da colagem.
export async function injectPrompt(
  pty: Pick<PtySession, 'write'>,
  text: string,
  mode: 'bracketed' | 'plain',
  submitDelayMs = 150,
): Promise<void> {
  const { body, submit } = encodePrompt(text, mode);
  pty.write(body);
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
  pty.write(submit);
}
