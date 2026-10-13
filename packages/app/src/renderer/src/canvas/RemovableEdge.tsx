import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { createContext, useContext, useState } from 'react';
import type { DisconnectableEdge } from './disconnect-edge';

/** Canvas fornece a remoção; o edge só pede, sem conhecer a API nem a store. */
export const DisconnectEdgeContext = createContext<(edge: DisconnectableEdge) => void>(() => {});

/** Aresta padrão (bezier, como antes) com um × no meio, visível em hover ou seleção. */
export function RemovableEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data, interactionWidth }: EdgeProps) {
  const disconnect = useContext(DisconnectEdgeContext);
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <g className="orq-edge-hit" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
      </g>
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label="Desconectar"
          title="Desconectar"
          className={`edge-remove nodrag nopan${hovered || selected ? ' visible' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(event) => { event.stopPropagation(); disconnect({ source, target, data }); }}
        >×</button>
      </EdgeLabelRenderer>
    </>
  );
}
