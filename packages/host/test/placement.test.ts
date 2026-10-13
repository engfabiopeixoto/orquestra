import { describe, expect, it } from 'vitest';
import { nextFree, NOTE_SIZE, placeBeside } from '../src/placement.js';

const author = { x: 100, y: 100, width: 640, height: 400 };

describe('placeBeside', () => {
  it('põe a nota à direita do autor, alinhada ao topo', () => {
    expect(placeBeside(author, [author], NOTE_SIZE)).toEqual({ x: 780, y: 100 });
  });

  it('desce até achar espaço livre quando a direita está ocupada', () => {
    const blocking = { x: 780, y: 100, width: 320, height: 240 };
    expect(placeBeside(author, [author, blocking], NOTE_SIZE)).toEqual({ x: 780, y: 380 });
  });
});

describe('nextFree', () => {
  it('canvas vazio começa em 80,80; depois vai à direita do mais à direita', () => {
    expect(nextFree([])).toEqual({ x: 80, y: 80 });
    expect(nextFree([author])).toEqual({ x: 780, y: 80 });
  });
});
