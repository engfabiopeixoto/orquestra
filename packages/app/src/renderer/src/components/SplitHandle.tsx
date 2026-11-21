import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Separador arrastável reutilizável (pointer capture + rAF + teclado + duplo clique). */
export function SplitHandle({
  orientation,
  ariaLabel,
  value,
  min,
  max,
  step = 16,
  reverse = false,
  className = '',
  testId,
  title,
  onChange,
  onCommit,
  onDraggingChange,
  onReset,
}: {
  orientation: 'vertical' | 'horizontal';
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  reverse?: boolean;
  className?: string;
  testId?: string;
  title?: string;
  onChange(nextValue: number): void;
  onCommit?(finalValue: number): void;
  onDraggingChange?(dragging: boolean): void;
  onReset?(): void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startCoord: number; startValue: number; lastValue: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingCoordRef = useRef<number | null>(null);
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  const clamp = (next: number) => Math.max(min, Math.min(Math.max(min, max), Math.round(next)));

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (dragRef.current) onDraggingChangeRef.current?.(false);
    };
  }, []);

  const flushDrag = (coord: number): number | null => {
    const active = dragRef.current;
    if (!active) return null;
    const delta = coord - active.startCoord;
    const next = clamp(active.startValue + (reverse ? -delta : delta));
    active.lastValue = next;
    onChange(next);
    return next;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startCoord = orientation === 'vertical' ? event.clientX : event.clientY;
    dragRef.current = { pointerId: event.pointerId, startCoord, startValue: value, lastValue: value };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignora em ambientes sem suporte completo de captura.
    }
    setDragging(true);
    onDraggingChange?.(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    pendingCoordRef.current = orientation === 'vertical' ? event.clientX : event.clientY;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingCoordRef.current !== null) {
        const coord = pendingCoordRef.current;
        pendingCoordRef.current = null;
        flushDrag(coord);
      }
    });
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    let finalValue = active.lastValue;
    if (pendingCoordRef.current !== null) {
      const coord = pendingCoordRef.current;
      pendingCoordRef.current = null;
      finalValue = flushDrag(coord) ?? finalValue;
    }
    dragRef.current = null;
    setDragging(false);
    onDraggingChange?.(false);
    onCommit?.(finalValue);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignora erro ao soltar captura já liberada.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let delta: number | null = null;
    if (orientation === 'vertical') {
      if (event.key === 'ArrowLeft') delta = reverse ? step : -step;
      else if (event.key === 'ArrowRight') delta = reverse ? -step : step;
    } else {
      if (event.key === 'ArrowUp') delta = -step;
      else if (event.key === 'ArrowDown') delta = step;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      const next = clamp(min);
      onChange(next);
      onCommit?.(next);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const next = clamp(max);
      onChange(next);
      onCommit?.(next);
      return;
    }
    if (delta !== null) {
      event.preventDefault();
      const next = clamp(value + delta);
      onChange(next);
      onCommit?.(next);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      aria-valuenow={clamp(value)}
      tabIndex={0}
      data-testid={testId}
      title={title}
      className={`split-handle split-handle-${orientation}${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onLostPointerCapture={stopDrag}
      onDoubleClick={() => onReset?.()}
      onKeyDown={onKeyDown}
    />
  );
}
