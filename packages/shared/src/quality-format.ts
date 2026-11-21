import { QUALITY_GUIDE } from './quality-guide.js';
import { QUALITY_METRICS, type QualityMetric, type QualityMetricId, type QualityReport, type QualitySignal } from './quality-schema.js';

const SIGNAL_LABELS: Record<QualitySignal, string> = {
  ok: 'OK',
  warn: 'ATENÇÃO',
  bad: 'PROBLEMA',
  missing: 'SEM DADOS',
};

function formatMetricValue(metric: QualityMetric): string {
  if (metric.value === null) return '-';
  switch (metric.id) {
    case 'size':
      return `${metric.value} linhas`;
    case 'complexity':
      return `${metric.value}`;
    case 'dependencies':
      return `${metric.value} ${metric.value === 1 ? 'ciclo' : 'ciclos'}`;
    case 'coverage':
    case 'mutation':
      return `${metric.value}%`;
  }
}

function formatDelta(metric: QualityMetric): string {
  if (metric.delta === null) return '';
  const sign = metric.delta > 0 ? '+' : '';
  const suffix = metric.id === 'coverage' || metric.id === 'mutation' ? '%' : '';
  return ` (${sign}${metric.delta}${suffix})`;
}

/** Formata o resumo em texto simples do `orq quality`. */
export function formatQualitySummary(report: QualityReport, opts: { changed: boolean }): string {
  if (report.language === 'unsupported') {
    return [
      'Por enquanto o painel só analisa JavaScript e TypeScript.',
      `Dica: use orq quality --explain <métrica> (${QUALITY_METRICS.join(', ')}) para ver os detalhes de cada métrica.`,
    ].join('\n');
  }

  const lines: string[] = [];
  for (const id of QUALITY_METRICS) {
    const metric = report.metrics.find((item) => item.id === id) ?? { id, signal: 'missing' as const, value: null, delta: null };
    const title = QUALITY_GUIDE[id].title;
    const signal = SIGNAL_LABELS[metric.signal];
    lines.push(`${title}: ${signal} — ${formatMetricValue(metric)}${formatDelta(metric)}`);
  }

  if (opts.changed) {
    lines.push('');
    lines.push('Nos arquivos alterados:');
    if (report.changed.length === 0) {
      lines.push('- Nenhuma piora detectada nos arquivos alterados.');
    } else {
      for (const item of report.changed) lines.push(`- ${item.path}: ${item.detail}`);
    }
  } else {
    if (report.hotspots.length > 0) {
      lines.push('');
      lines.push('Pontos críticos:');
      for (const spot of report.hotspots) lines.push(`- ${spot.path}: ${spot.reason}`);
    }
    if (report.changed.length > 0) {
      lines.push('');
      lines.push('Nos arquivos alterados:');
      for (const item of report.changed) lines.push(`- ${item.path}: ${item.detail}`);
    }
  }

  lines.push('');
  lines.push(`Dica: use orq quality --explain <métrica> (${QUALITY_METRICS.join(', ')}) para ver o que significa e como melhorar.`);
  return lines.join('\n');
}

/** Formata a explicação completa de uma métrica para `orq quality --explain`. */
export function formatQualityExplain(id: QualityMetricId): string {
  const entry = QUALITY_GUIDE[id];
  return [
    entry.title,
    `O que é: ${entry.what}`,
    `Por que importa: ${entry.why}`,
    `Limites usados aqui: ${entry.limits}`,
    `Como melhorar: ${entry.improve}`,
  ].join('\n');
}
