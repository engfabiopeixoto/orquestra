import { describe, expect, it } from 'vitest';
import { isDetachKey } from '../../../dev/harness-keys.js';

describe('isDetachKey', () => {
  it('aceita Ctrl+Q, F12 e Ctrl+] como teclas de soltar', () => {
    expect(isDetachKey('\x11')).toBe(true);
    expect(isDetachKey('\x1b[24~')).toBe(true);
    expect(isDetachKey('\x1d')).toBe(true);
  });

  it('não confunde teclas comuns nem Ctrl+C', () => {
    expect(isDetachKey('q')).toBe(false);
    expect(isDetachKey('\x03')).toBe(false);
    expect(isDetachKey('\r')).toBe(false);
  });
});
