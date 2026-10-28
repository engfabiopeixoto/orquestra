import { describe, expect, it } from 'vitest';
import { portalNodeBounds, portalPresentation, type PortalRect } from '../src/renderer/src/portal/portal-presentation';

const canvas: PortalRect = { left: 0, top: 0, right: 1200, bottom: 800 };
const node: PortalRect = { left: 100, top: 100, right: 900, bottom: 600 };

describe('portalPresentation', () => {
  it('uses the live view only when at 100%, fully visible, unobstructed and stopped', () => {
    expect(portalPresentation({ nodeRect: node, visibleRect: canvas, zoom: 1, overlapped: false, moving: false })).toBe('live');
  });

  it.each([
    ['zoomed out', { zoom: 0.5 }],
    ['zoomed in', { zoom: 1.5 }],
    ['slightly outside visible area', { nodeRect: { ...node, left: -1 } }],
    ['covered by an overlay', { overlapped: true }],
    ['moving', { moving: true }],
  ])('uses a snapshot when %s', (_label, override) => {
    expect(portalPresentation({ nodeRect: node, visibleRect: canvas, zoom: 1, overlapped: false, moving: false, ...override })).toBe('snapshot');
  });

  it('keeps full node bounds without intersecting the visible canvas', () => {
    const partiallyOffscreen: PortalRect = { left: -400, top: 20, right: 400, bottom: 520 };
    expect(portalNodeBounds(partiallyOffscreen)).toEqual({ x: -400, y: 20, width: 800, height: 500 });
  });

  it('accepts the terminal zoom tolerance around 100%', () => {
    expect(portalPresentation({ nodeRect: node, visibleRect: canvas, zoom: 1.001, overlapped: false, moving: false })).toBe('live');
    expect(portalPresentation({ nodeRect: node, visibleRect: canvas, zoom: 1.0011, overlapped: false, moving: false })).toBe('snapshot');
  });
});
