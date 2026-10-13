import type { Position, Size } from '@orquestra/shared';

export type Rect = Position & Size;

export const TERMINAL_SIZE: Size = { width: 640, height: 400 };
export const NOTE_SIZE: Size = { width: 320, height: 240 };
export const GAP = 40;

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Spec, seção 5: nota criada por um agente nasce à direita dele, no primeiro espaço livre (descendo). */
export function placeBeside(author: Rect, others: Rect[], size: Size): Position {
  const candidate = { x: author.x + author.width + GAP, y: author.y, ...size };
  while (others.some((other) => overlaps(candidate, other))) candidate.y += size.height + GAP;
  return { x: candidate.x, y: candidate.y };
}

export function nextFree(others: Rect[]): Position {
  if (others.length === 0) return { x: 80, y: 80 };
  return { x: Math.max(...others.map((other) => other.x + other.width)) + GAP, y: 80 };
}
