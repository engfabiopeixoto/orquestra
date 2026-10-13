import { describe, expect, it } from 'vitest';
import { encodePrompt, encodeWithWin32, writePrompt } from '../src/input.js';

describe('encodePrompt', () => {
  it('usa LF nas quebras de linha e separa o Enter', () => {
    expect(encodePrompt('a\nb\r\nc\rd')).toEqual({ body: '\x1b[200~a\nb\nc\nd\x1b[201~', submit: '\r' });
  });

  it('remove marcadores de colagem vindos do texto', () => {
    expect(encodePrompt('x\x1b[201~y').body).toBe('\x1b[200~xy\x1b[201~');
  });
});

describe('writePrompt', () => {
  it('escreve o corpo, espera e envia o Enter num write separado', async () => {
    const writes: string[] = [];
    await writePrompt({ write: (data) => writes.push(data) }, 'oi', { submitDelayMs: 1 });
    expect(writes).toEqual(['\x1b[200~oi\x1b[201~', '\r']);
  });

  it('aplica a codificação do adaptador ao corpo', async () => {
    const writes: string[] = [];
    await writePrompt({ write: (data) => writes.push(data) }, 'oi', { submitDelayMs: 1, encode: (body) => body.toUpperCase() });
    expect(writes[0]).toBe('\x1b[200~OI\x1b[201~');
  });
});

describe('encodeWithWin32', () => {
  it('troca só os caracteres inseguros por eventos de tecla (pressionar e soltar)', () => {
    expect(encodeWithWin32('a×', (char) => char === '×')).toBe('a\x1b[0;0;215;1;0;1_\x1b[0;0;215;0;0;1_');
  });

  it('envia cada unidade UTF-16 de um emoji', () => {
    const encoded = encodeWithWin32('🚀', () => true);
    expect(encoded).toBe(
      '\x1b[0;0;55357;1;0;1_\x1b[0;0;55357;0;0;1_\x1b[0;0;56960;1;0;1_\x1b[0;0;56960;0;0;1_',
    );
  });
});
