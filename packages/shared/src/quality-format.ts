import { QUALITY_GUIDE } from './quality-guide.js';
import { QUALITY_METRICS, type QualityChange, type QualityMetric, type QualityMetricId, type QualityReport, type QualitySignal } from './quality-schema.js';

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

/** Formata as cinco linhas de resumo das métricas de um relatório. */
function formatMetricLines(report: QualityReport): string[] {
  return QUALITY_METRICS.map((id) => {
    const metric = report.metrics.find((item) => item.id === id) ?? { id, signal: 'missing' as const, value: null, delta: null };
    return `${QUALITY_GUIDE[id].title}: ${SIGNAL_LABELS[metric.signal]} — ${formatMetricValue(metric)}${formatDelta(metric)}`;
  });
}

/** Formata o resumo em texto simples do `orq quality`. */
export function formatQualitySummary(report: QualityReport, opts: { changed: boolean }): string {
  if (report.language === 'unsupported') {
    return [
      'Por enquanto o painel só analisa JavaScript e TypeScript.',
      `Dica: use orq quality --explain <métrica> (${QUALITY_METRICS.join(', ')}) para ver os detalhes de cada métrica.`,
    ].join('\n');
  }

  const lines = formatMetricLines(report);

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

const REVIEW_MAX_LINES = 40;
const REVIEW_MAX_BYTES = 4096;
const REVIEW_QUALITY_BANNER = '\n\n--- Qualidade (orq quality --changed, anexado pelo Orquestra) ---\n';
export const MAX_QUALITY_ATTACH_MS = 30_000;

const utf8Encoder = new TextEncoder();

function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

const CHANGE_KIND_METRIC: Record<QualityChange['kind'], QualityMetricId> = {
  'file-over-limit': 'size',
  'function-over-limit': 'complexity',
  'new-cycle': 'dependencies',
};

function isWorseDelta(metric: QualityMetric): boolean {
  if (metric.delta === null || metric.delta === 0) return false;
  return metric.id === 'coverage' || metric.id === 'mutation' ? metric.delta < 0 : metric.delta > 0;
}

function moreItemsLine(remaining: number): string {
  return `(mais ${remaining} ${remaining === 1 ? 'item' : 'itens'}; rode orq quality --changed)`;
}

/** Formata o resumo compacto de qualidade anexado em pedidos de revisão (`--quality`). */
export function formatQualityForReview(report: QualityReport): string {
  if (report.language === 'unsupported') {
    return 'Medição de qualidade não se aplica a este projeto (apenas js-ts).';
  }

  const lines = formatMetricLines(report);
  const badMetrics = QUALITY_METRICS
    .map((id) => report.metrics.find((item) => item.id === id))
    .filter((item): item is QualityMetric => item?.signal === 'bad');

  const newOrWorsened = badMetrics.filter(
    (metric) => isWorseDelta(metric) || report.changed.some((item) => CHANGE_KIND_METRIC[item.kind] === metric.id),
  );
  const existingBad = badMetrics.filter((metric) => !newOrWorsened.includes(metric));

  if (newOrWorsened.length > 0) {
    lines.push(`Vermelhos novos ou piorados: ${newOrWorsened.map((metric) => QUALITY_GUIDE[metric.id].title).join(', ')}.`);
  }
  if (existingBad.length > 0) {
    lines.push(`Vermelhos que já existiam: ${existingBad.map((metric) => QUALITY_GUIDE[metric.id].title).join(', ')}.`);
  }

  lines.push('');
  if (report.changed.length === 0) {
    lines.push('Nos arquivos alterados: nenhuma piora detectada.');
    return lines.join('\n');
  }

  lines.push('Nos arquivos alterados:');
  let bytes = byteLength(lines.join('\n'));
  for (let i = 0; i < report.changed.length; i++) {
    const item = report.changed[i]!;
    const line = `- ${item.path}: ${item.detail}`;
    const remaining = report.changed.length - i;
    const hasMore = i < report.changed.length - 1;
    const nextBytes = bytes + 1 + byteLength(line);
    const reserveBytes = hasMore ? 1 + byteLength(moreItemsLine(remaining - 1)) : 0;
    const lineBudget = hasMore ? REVIEW_MAX_LINES - 1 : REVIEW_MAX_LINES;

    if (lines.length + 1 > lineBudget || nextBytes + reserveBytes > REVIEW_MAX_BYTES) {
      lines.push(moreItemsLine(remaining));
      break;
    }
    lines.push(line);
    bytes = nextBytes;
  }

  return lines.join('\n');
}

/** Anexa o resumo de qualidade ao texto do prompt com prazo próprio sem bloquear o envio em caso de falha ou timeout. */
export async function attachQualityForReview(
  text: string,
  timeoutMs: number,
  fetchQuality: (signal: AbortSignal) => Promise<QualityReport>,
  warn: (message: string) => void,
  externalSignal?: AbortSignal,
): Promise<{ text: string; remainingTimeoutMs: number }> {
  if (externalSignal?.aborted) {
    throw new Error('Consulta cancelada.');
  }

  const startedAt = Date.now();
  const qualityBudgetMs = Math.max(1, Math.min(MAX_QUALITY_ATTACH_MS, Math.floor(timeoutMs / 4)));
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, qualityBudgetMs);

  try {
    const report = await fetchQuality(controller.signal);
    const remainingTimeoutMs = Math.max(1, timeoutMs - Math.max(0, Date.now() - startedAt));
    return {
      text: `${text}${REVIEW_QUALITY_BANNER}${formatQualityForReview(report)}`,
      remainingTimeoutMs,
    };
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    if (timedOut) {
      warn(`Aviso: medição de qualidade excedeu ${qualityBudgetMs} ms; enviando prompt sem qualidade.\n`);
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`Aviso: não foi possível anexar a medição de qualidade (${reason}).\n`);
    }
    const remainingTimeoutMs = Math.max(1, timeoutMs - Math.max(0, Date.now() - startedAt));
    return { text, remainingTimeoutMs };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
