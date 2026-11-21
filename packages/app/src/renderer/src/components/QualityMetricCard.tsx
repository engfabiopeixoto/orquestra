import { useState } from 'react';
import { QUALITY_GUIDE, type QualityRefactorChoice } from '@orquestra/shared/quality-guide';
import type { QualityMetric, QualityMetricId, QualityRefactorTarget, QualitySignal } from '@orquestra/shared/quality-schema';
import { QualityAskMenuButton, type QualityAgentTerminal } from './QualityAskMenuButton';

export type { QualityAgentTerminal };

export type QualityAskRequest =
  | { kind: 'coverage' | 'mutation' }
  | { kind: 'refactor'; target: QualityRefactorTarget };

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
  refactorTarget,
  openMenuId,
  onOpenMenuChange,
  onAskAgent,
}: {
  metric: QualityMetric;
  terminals: QualityAgentTerminal[];
  staleCoverage?: boolean;
  refactorTarget?: QualityRefactorChoice | null;
  openMenuId?: string | null;
  onOpenMenuChange?(id: string | null): void;
  onAskAgent(terminalName: string, request: QualityAskRequest): void;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const guide = QUALITY_GUIDE[metric.id];
  const delta = deltaInfo(metric.id, metric.delta);
  const askKind = metric.id === 'coverage' || metric.id === 'mutation' ? metric.id : null;
  const canRefactor =
    (metric.id === 'size' || metric.id === 'complexity' || metric.id === 'dependencies') &&
    (metric.signal === 'warn' || metric.signal === 'bad') &&
    Boolean(refactorTarget);
  const cardMenuId = `card-${metric.id}`;

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
          <QualityAskMenuButton
            label="Pedir a um agente"
            className="quality-ask-btn"
            title="Escolher agente para configurar"
            menuAriaLabel={`Escolher agente para ${guide.title}`}
            terminals={terminals}
            open={openMenuId !== undefined ? openMenuId === cardMenuId : undefined}
            onOpenChange={onOpenMenuChange ? (next) => onOpenMenuChange(next ? cardMenuId : null) : undefined}
            onSelectTerminal={(name) => onAskAgent(name, { kind: askKind })}
          />
        </div>
      ) : null}

      {canRefactor && refactorTarget ? (
        <div className="quality-missing">
          <small className="quality-ask-target">{`Alvo: ${refactorTarget.label}`}</small>
          <QualityAskMenuButton
            label="Pedir refatoração a um agente"
            className="quality-ask-btn"
            title={`Alvo: ${refactorTarget.label}`}
            ariaLabel={`Pedir refatoração de ${guide.title}: ${refactorTarget.label}`}
            menuAriaLabel={`Escolher agente para ${guide.title}: ${refactorTarget.label}`}
            terminals={terminals}
            open={openMenuId !== undefined ? openMenuId === cardMenuId : undefined}
            onOpenChange={onOpenMenuChange ? (next) => onOpenMenuChange(next ? cardMenuId : null) : undefined}
            onSelectTerminal={(name) => onAskAgent(name, { kind: 'refactor', target: refactorTarget.target })}
          />
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
    </article>
  );
}
