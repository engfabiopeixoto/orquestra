import { OrqError } from '@orquestra/shared';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(text.trim());
  if (!match) throw new OrqError('USAGE', `Duração inválida: ${text}. Use, por exemplo, 8m, 30s ou 500ms.`);
  return Number(match[1]) * UNITS[match[2] ?? 's']!;
}
