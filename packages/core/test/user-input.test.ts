import { describe, expect, it } from 'vitest';
import { hasUserKeystroke, keyboardInput } from '../src/user-input.js';

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

  it.each([
    ['CPR padrão', '\x1b[12;34R'],
    ['CPR DEC', '\x1b[?1;1R'],
    ['DSR status', '\x1b[0n'],
    ['DSR DEC', '\x1b[?26n'],
    ['DA1', '\x1b[?62;1;2;6;7;8;9c'],
    ['DA2', '\x1b[>0;276;0c'],
    ['DA3', '\x1b[=0c'],
    ['DECRPM modo privado', '\x1b[?2004;2$y'],
    ['DECRPM modo ANSI', '\x1b[4;0$y'],
    ['XTWINOPS tamanho/estado', '\x1b[4;500;800t\x1b[8;24;80t\x1b[1t'],
    ['OSC 10 com ST', '\x1b]10;rgb:d6d6/dada/e2e2\x1b\\'],
    ['OSC 11 com BEL', '\x1b]11;rgb:1616/1a1a/2121\x07'],
    ['OSC 4 paleta', '\x1b]4;1;rgb:ff/00/00\x1b\\'],
    ['DCS XTVERSION / DECRQSS', '\x1bP>|xterm.js(5.5.0)\x1b\\\x1bP1$r0m\x1b\\'],
  ])('ignora resposta automática de terminal: %s', (_label, reply) => {
    expect(hasUserKeystroke(reply)).toBe(false);
    expect(keyboardInput(reply)).toBe('');
  });

  it('reconhece tecla misturada com aviso de foco, mouse ou relatório OSC/DCS/CSI', () => {
    expect(hasUserKeystroke('\x1b[Ia')).toBe(true);
    expect(hasUserKeystroke('\x1b[<0;10;20M1')).toBe(true);
    expect(keyboardInput('\x1b]10;rgb:d6d6/dada/e2e2\x1b\\a\x1b[>0;276;0c')).toBe('a');
  });

  it.each(['a', '1', '\r', '\x1b[A', '\x1b[15~', '\x1b[200~oi\x1b[201~', '\x1b', 'texto colado'])('reconhece entrada real %j', (data) => {
    expect(hasUserKeystroke(data)).toBe(true);
    expect(keyboardInput(data)).toBe(data);
  });

  it('win32-input (Codex): descarta keyup e normaliza keydown de texto, Enter, Ctrl+C, Ctrl+U, Backspace, Esc e setas', () => {
    // keyup (Kd=0) de Alt, Enter e letra não contam como entrada
    expect(hasUserKeystroke('\x1b[18;56;0;0;0;1_\x1b[13;28;13;0;0;1_\x1b[65;30;97;0;0;1_')).toBe(false);
    expect(keyboardInput('\x1b[18;56;0;0;0;1_')).toBe('');

    // Texto normal ("oi") + keyups descartados
    expect(keyboardInput('\x1b[79;24;111;1;0;1_\x1b[79;24;111;0;0;1_\x1b[73;23;105;1;0;1_\x1b[73;23;105;0;0;1_')).toBe('oi');

    // Enter, Ctrl+C, Ctrl+U, Backspace, Esc
    expect(keyboardInput('\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_')).toBe('\r');
    expect(keyboardInput('\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_')).toBe('\x03');
    expect(keyboardInput('\x1b[85;22;21;1;8;1_\x1b[85;22;21;0;8;1_')).toBe('\x15');
    expect(keyboardInput('\x1b[8;14;8;1;0;1_\x1b[8;14;127;1;8;1_')).toBe('\b\x7f');
    expect(keyboardInput('\x1b[27;1;27;1;0;1_')).toBe('\x1b');
    expect(keyboardInput('\x1b[27;1;0;1;0;1_')).toBe('\x1b[27;1;0;1;0;1_');

    // Setas: cima/baixo viram VT [A/[B; esquerda/direita/Shift ficam como CSI _
    expect(keyboardInput('\x1b[38;72;0;1;256;1_')).toBe('\x1b[A');
    expect(keyboardInput('\x1b[40;80;0;1;256;1_')).toBe('\x1b[B');
    expect(keyboardInput('\x1b[37;75;0;1;256;1_')).toBe('\x1b[37;75;0;1;256;1_');
    expect(keyboardInput('\x1b[16;42;0;1;16;1_')).toBe('\x1b[16;42;0;1;16;1_');
  });
});
