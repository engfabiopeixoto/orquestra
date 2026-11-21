import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QUALITY_GUIDE } from '@orquestra/shared/quality-guide';
import type { QualityMetric, QualityMetricId, QualitySignal } from '@orquestra/shared/quality-schema';
import { usePortalOverlay } from '../portal/modal-overlay';

export type QualityAgentTerminal = {
  name: string;
  agent: string;
  state?: string;
  unloaded?: boolean;
};

const SIGNAL_TEXT: Record<QualitySignal, string> = {
  ok: 'OK',
  warn: 'ATENÇÃO',
  bad: 'PROBLEMA',
  missing: 'SEM DADOS',
};

function formatMetricValue(id: QualityMetricId, value: number | null): string {
  if (value === null) return '-';
  if (id === 'size') return `${value} linhas`;
  if (id === 'complexity') return `${value}`;
  if (id === 'dependencies') return `${value} ${value === 1 ? 'ciclo' : 'ciclos'}`;
  return `${value}%`;
}

function deltaInfo(id: QualityMetricId, delta: number | null): { text: string; tone: 'better' | 'worse' | 'flat' } | null {
  if (delta === null) return null;
  if (delta === 0) return { text: 'sem variação', tone: 'flat' };
  const higherIsBetter = id === 'coverage' || id === 'mutation';
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  const arrow = delta > 0 ? '▲' : '▼';
  const sign = delta > 0 ? '+' : '';
  const suffix = higherIsBetter ? '%' : '';
  return {
    text: `${arrow} ${sign}${delta}${suffix} ${improved ? 'melhorou' : 'piorou'}`,
    tone: improved ? 'better' : 'worse',
  };
}

export function QualityMetricCard({
  metric,
  terminals,
  staleCoverage,
  onAskAgent,
}: {
  metric: QualityMetric;
  terminals: QualityAgentTerminal[];
  staleCoverage?: boolean;
  onAskAgent(terminalName: string, kind: 'coverage' | 'mutation'): void;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const askButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const guide = QUALITY_GUIDE[metric.id];
  const delta = deltaInfo(metric.id, metric.delta);
  const askKind = metric.id === 'coverage' || metric.id === 'mutation' ? metric.id : null;
  const eligibleTerminals = terminals.filter((t) => t.agent !== 'shell' && !t.unloaded && t.state !== 'exited');
  const menuOpen = menuPos !== null && askKind !== null && eligibleTerminals.length > 0;
  usePortalOverlay(menuOpen);

  useEffect(() => {
    if (menuPos && eligibleTerminals.length === 0) setMenuPos(null);
  }, [menuPos, eligibleTerminals.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !askButtonRef.current?.contains(target)) {
        setMenuPos(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuPos(null);
        askButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    const rect = askButtonRef.current?.getBoundingClientRect();
    setMenuPos((current) =>
      current
        ? null
        : {
            left: Math.min(rect?.left ?? 10, Math.max(8, window.innerWidth - 220)),
            top: Math.min((rect?.bottom ?? 80) + 4, Math.max(8, window.innerHeight - 140)),
          },
    );
  };

  return (
    <article className={`quality-card is-${metric.signal}`} data-testid={`quality-card-${metric.id}`}>
      <div className="quality-card-head">
        <strong className="quality-card-title">{guide.title}</strong>
        <button
          type="button"
          className="quality-help-btn"
          aria-label={`Explicar ${guide.title}`}
          aria-expanded={guideOpen}
          title="O que significa esta métrica"
          onClick={() => setGuideOpen((open) => !open)}
        >
          ?
        </button>
      </div>
      <div className="quality-card-metrics">
        <span className={`quality-signal is-${metric.signal}`}>{SIGNAL_TEXT[metric.signal]}</span>
        <span className="quality-value">{formatMetricValue(metric.id, metric.value)}</span>
      </div>
      {delta ? <div className={`quality-delta is-${delta.tone}`}>{delta.text}</div> : null}
      {staleCoverage && metric.id === 'coverage' && metric.signal !== 'missing' ? (
        <small className="quality-stale">Relatório antigo (anterior à última alteração).</small>
      ) : null}

      {metric.signal === 'missing' && askKind ? (
        <div className="quality-missing">
          <p className="quality-missing-text">{guide.what}</p>
          <button
            ref={askButtonRef}
            type="button"
            className="quality-ask-btn"
            disabled={eligibleTerminals.length === 0}
            title={eligibleTerminals.length === 0 ? 'Abra um terminal de agente' : 'Escolher agente para configurar'}
            aria-haspopup="menu"
            aria-expanded={menuPos !== null}
            onClick={toggleMenu}
          >
            Pedir a um agente
          </button>
        </div>
      ) : null}

      {guideOpen ? (
        <div className="quality-guide">
          <p><strong>O que é:</strong> {guide.what}</p>
          <p><strong>Por que importa:</strong> {guide.why}</p>
          <p><strong>Limites usados aqui:</strong> {guide.limits}</p>
          <p><strong>Como melhorar:</strong> {guide.improve}</p>
        </div>
      ) : null}

      {menuOpen && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              className="ctx ctx-menu quality-agent-menu"
              role="menu"
              aria-label={`Escolher agente para ${guide.title}`}
              style={{ position: 'fixed', left: menuPos.left, top: menuPos.top }}
            >
              {eligibleTerminals.map((terminal) => (
                <button
                  key={terminal.name}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuPos(null);
                    onAskAgent(terminal.name, askKind);
                  }}
                >
                  {`${terminal.name} (${terminal.agent})`}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </article>
  );
}
