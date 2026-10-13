import { describe, expect, it } from 'vitest';
import { encodePrompt, injectPrompt } from '../src/inject.js';

describe('encodePrompt', () => {
  it('envolve o texto em colagem entre colchetes e separa o Enter', () => {
    expect(encodePrompt('oi', 'bracketed')).toEqual({ body: '\x1b[200~oi\x1b[201~', submit: '\r' });
  });

  // O ConPTY descarta os marcadores de colagem; um CR no meio enviaria o prompt pela metade.
  // LF (Ctrl+J) insere quebra de linha no campo de entrada sem enviar (testado no Claude Code).
  it('usa LF nas quebras de linha dentro da colagem, para não enviar o prompt', () => {
    const { body, submit } = encodePrompt('a\nb\r\nc\rd', 'bracketed');
    expect(body).toBe('\x1b[200~a\nb\nc\nd\x1b[201~');
    expect(submit).toBe('\r');
  });

  it('remove marcadores de colagem que vierem dentro do texto', () => {
    expect(encodePrompt('x\x1b[201~y', 'bracketed').body).toBe('\x1b[200~xy\x1b[201~');
  });

  it('no modo plain, recusa texto com várias linhas', () => {
    expect(() => encodePrompt('a\nb', 'plain')).toThrow(/várias linhas/);
  });
});

describe('injectPrompt', () => {
  it('escreve o corpo, espera e envia o Enter', async () => {
    const writes: string[] = [];
    await injectPrompt({ write: (data) => writes.push(data) }, 'oi', 'bracketed', 1);
    expect(writes).toEqual(['\x1b[200~oi\x1b[201~', '\r']);
  });
});
