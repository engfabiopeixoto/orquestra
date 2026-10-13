import { useReactFlow, useViewport } from '@xyflow/react';

export function ZoomControl() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="zoom" onMouseDown={(event) => event.preventDefault()}>
      <button onClick={() => void zoomOut({ duration: 150 })} aria-label="Diminuir zoom">−</button>
      <button data-testid="zoom-level" onClick={() => void zoomTo(1, { duration: 150 })} title="Voltar a 100% (Ctrl+0)">
        {Math.round(zoom * 100)}%
      </button>
      <button onClick={() => void zoomIn({ duration: 150 })} aria-label="Aumentar zoom">+</button>
      <button onClick={() => void fitView({ duration: 200, padding: 0.1 })} title="Ajustar (Ctrl+1)">Ajustar</button>
    </div>
  );
}
