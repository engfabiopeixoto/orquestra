import type { PortalViewBounds } from '../../../shared/portal-protocol';

export interface PortalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PortalPresentationInput {
  nodeRect: PortalRect;
  visibleRect: PortalRect;
  zoom: number;
  overlapped: boolean;
  moving: boolean;
}

export function portalPresentation({ nodeRect, visibleRect, zoom, overlapped, moving }: PortalPresentationInput): 'live' | 'snapshot' {
  const atFullZoom = Math.abs(zoom - 1) <= 0.001;
  const fullyVisible = nodeRect.left >= visibleRect.left && nodeRect.top >= visibleRect.top && nodeRect.right <= visibleRect.right && nodeRect.bottom <= visibleRect.bottom;
  return atFullZoom && fullyVisible && !overlapped && !moving ? 'live' : 'snapshot';
}

export function portalNodeBounds(rect: PortalRect): PortalViewBounds {
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}
