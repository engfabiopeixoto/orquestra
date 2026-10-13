/**
 * `visible`: o sinal vale enquanto o padrão estiver na área visível (diálogos de permissão).
 * `new-occurrence`: o sinal dispara quando o terminal inteiro passa a ter mais ocorrências do padrão
 * do que já teve (mensagens que ficam na tela, como "Interrupted": a segunda conta e um redesenho não).
 */
export type ScreenRule<S extends string> = { pattern: RegExp; signal: S; scope?: 'visible' | 'new-occurrence' };

export class ScreenWatcher<S extends string> {
  private showing = new Set<S>();
  private readonly highWater = new Map<ScreenRule<S>, number>();

  constructor(private readonly rules: ScreenRule<S>[]) {}

  update(visibleText: string, fullText: string = visibleText): { appeared: S[]; visible: Set<S> } {
    const visible = new Set<S>();
    const appeared = new Set<S>();
    for (const rule of this.rules) {
      if (rule.scope === 'new-occurrence') {
        const count = countMatches(rule.pattern, fullText);
        if (count > (this.highWater.get(rule) ?? 0)) {
          appeared.add(rule.signal);
          this.highWater.set(rule, count);
        }
        continue;
      }
      if (rule.pattern.test(visibleText)) visible.add(rule.signal);
    }
    for (const signal of visible) if (!this.showing.has(signal)) appeared.add(signal);
    this.showing = visible;
    return { appeared: [...appeared], visible };
  }
}

function countMatches(pattern: RegExp, text: string): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return text.match(global)?.length ?? 0;
}
