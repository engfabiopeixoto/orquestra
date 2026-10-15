import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { createContext, useContext, useState } from 'react';
import type { DisconnectableEdge } from './disconnect-edge';
import type { EdgeActivity } from './edge-activity';

/** Canvas fornece a remoção; o edge só pede, sem conhecer a API nem a store. */
export const DisconnectEdgeContext = createContext<(edge: DisconnectableEdge) => void>(() => {});

const PILL_LABEL: Record<EdgeActivity['kind'], string> = { prompt: '⚡ delegando', delivery: '📩 entregando', reply: '📩 retornando' };

/** Aresta padrão (bezier, como antes) com um × no meio, visível em hover ou seleção. */
export function RemovableEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data, interactionWidth }: EdgeProps) {
  const disconnect = useContext(DisconnectEdgeContext);
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const activity = data?.activity as EdgeActivity | undefined;
  const controlsVisible = hovered || Boolean(selected);
  const center = `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`;
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
          className={`edge-remove nodrag nopan${controlsVisible ? ' visible' : ''}`}
          style={{ transform: center }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          onClick={(event) => { event.stopPropagation(); disconnect({ source, target, data }); }}
        >×</button>
        {activity && !controlsVisible ? <span className="edge-pill" data-testid={`edge-pill-${id}`} style={{ transform: center }}>{PILL_LABEL[activity.kind]}</span> : null}
      </EdgeLabelRenderer>
    </>
  );
}
