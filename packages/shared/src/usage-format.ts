import type { ProviderUsageResult } from './protocol.js';

export function formatResetTime(resetsAtIso: string, now = Date.now()): string | null {
  const resetTime = new Date(resetsAtIso).getTime();
  if (isNaN(resetTime)) return null;
  const diffMs = resetTime - now;
  if (diffMs <= 0) return 'agora';

  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 24 * 60) {
    const h = Math.floor(diffMinutes / 60);
    const m = diffMinutes % 60;
    const timeStr = h > 0 ? (m > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${h}h`) : `${m}m`;
    return `em ${timeStr}`;
  }

  const date = new Date(resetTime);
  const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const weekday = weekdays[date.getDay()];
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${weekday} ${h}:${m}`;
}

export function formatWindowLabel(label: string): string {
  const trimmed = label.trim();
  if (/^5\s*h$/i.test(trimmed) || /^sessão$/i.test(trimmed)) return 'sessão 5h';
  if (/^7\s*dias$/i.test(trimmed) || /^semanal$/i.test(trimmed)) return 'semanal';
  if (/·\s*5\s*h$/i.test(trimmed)) return trimmed.replace(/·\s*5\s*h$/i, '· sessão 5h');
  if (/·\s*7\s*dias$/i.test(trimmed)) return trimmed.replace(/·\s*7\s*dias$/i, '· semanal');
  return trimmed;
}

export function formatProviderUsage(result: ProviderUsageResult, now = Date.now()): string {
  const prefix = result.provider.padEnd(6, ' ') + '  ';
  if (result.error) {
    return `${prefix}erro: ${result.error}`;
  }
  if (!result.usage) {
    return `${prefix}erro: Consulta indisponível.`;
  }

  const parts: string[] = [];
  for (const window of result.usage.windows) {
    const label = formatWindowLabel(window.label);
    const reset = window.resetsAt ? formatResetTime(window.resetsAt, now) : null;
    const resetStr = reset ? `, renova ${reset}` : '';
    parts.push(`${label}: ${window.usedPercent}% usado${resetStr}`);
  }

  if (result.usage.credits) {
    parts.push(`créditos: ${result.usage.credits}`);
  }

  if (parts.length === 0) {
    parts.push('sem limites de assinatura');
  }

  return `${prefix}${parts.join(' | ')}`;
}

export function formatUsageSummary(results: ProviderUsageResult[], now = Date.now()): string {
  return results.map((result) => formatProviderUsage(result, now)).join('\n');
}
