// Teclas que soltam o terminal anexado no harness. Ctrl+] não existe em teclados ABNT2 (a tecla ] fica
// em outra posição), então aceitamos também Ctrl+Q e F12, que funcionam em qualquer layout.
const DETACH_KEYS = new Set(['\x11', '\x1b[24~', '\x1d']);

export const DETACH_HINT = 'Ctrl+Q ou F12';

export function isDetachKey(text: string): boolean {
  return DETACH_KEYS.has(text);
}
