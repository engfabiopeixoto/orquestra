import { describe, expect, it } from 'vitest';
import { portalBoundsInFrame, portalZoomFactor } from '../src/shared/portal-protocol';

describe('bounds e zoom do portal', () => {
  it('mantém o retângulo inteiro do nó relativo à moldura, inclusive fora dela', () => {
    const frame = { x: 220, y: 32, width: 1180, height: 868 };
    const node = { x: 20, y: 273, width: 798, height: 478 };
    expect(portalBoundsInFrame(node, frame)).toEqual({ x: -200, y: 241, width: 798, height: 478 });
  });

  it('compõe o zoom do canvas com o zoom próprio do portal', () => {
    expect(portalZoomFactor(0.5, 1)).toBe(0.5);
    expect(portalZoomFactor(1, 1.25)).toBe(1.25);
    expect(portalZoomFactor(0.5, 1.25)).toBe(0.625);
  });
});
