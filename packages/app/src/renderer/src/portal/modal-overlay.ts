import { useEffect, useRef } from 'react';

const activeOverlays = new Set<symbol>();
let syncedBlocked: boolean | undefined;

export function syncPortalModalState(forceInitial = false): void {
  const blocked = activeOverlays.size > 0;
  if (blocked !== syncedBlocked || (forceInitial && syncedBlocked === undefined)) {
    syncedBlocked = blocked;
    void window.orquestra?.portal?.setModalState(blocked);
  }
}

export function usePortalOverlay(active: boolean): void {
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol();
  useEffect(() => {
    const token = tokenRef.current!;
    if (!active) return;
    activeOverlays.add(token);
    syncPortalModalState();
    return () => {
      activeOverlays.delete(token);
      syncPortalModalState();
    };
  }, [active]);
}

export function resetPortalOverlaysForTest(): void {
  activeOverlays.clear();
  syncedBlocked = undefined;
}
