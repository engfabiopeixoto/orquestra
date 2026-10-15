import { describe, expect, it } from 'vitest';
import { hasUserKeystroke } from '../src/user-input.js';

describe('hasUserKeystroke', () => {
  it('ignora apenas avisos de foco', () => {
    expect(hasUserKeystroke('\x1b[I\x1b[O')).toBe(false);
  });

  it('ignora relatórios SGR de pressionar e soltar mouse', () => {
    expect(hasUserKeystroke('\x1b[<0;10;20M\x1b[<0;10;20m')).toBe(false);
  });

  it('ignora relatório X10 com os três bytes de posição', () => {
    expect(hasUserKeystroke('\x1b[M !"')).toBe(false);
  });

  it('reconhece tecla misturada com aviso de foco ou relatório de mouse', () => {
    expect(hasUserKeystroke('\x1b[Ia')).toBe(true);
    expect(hasUserKeystroke('\x1b[<0;10;20M1')).toBe(true);
  });

  it.each(['a', '1', '\r', '\x1b[A', '\x1b', 'texto colado'])('reconhece entrada real %j', (data) => {
    expect(hasUserKeystroke(data)).toBe(true);
  });
});
