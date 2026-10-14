/**
 * `visible`: o sinal vale enquanto o padrão estiver na área visível (diálogos de permissão).
 * `new-occurrence`: compara, por texto de linha, quantas ocorrências havia no início do turno.
 * Deslocamentos e repaints mantêm a contagem; uma contagem maior é um evento novo. Se uma linha
 * antiga idêntica sair e outra entrar no mesmo update, a contagem não muda e a troca passa despercebida.
 */
export type ScreenRule<S extends string> = { pattern: RegExp; signal: S; scope?: 'visible' | 'new-occurrence' };

export class ScreenWatcher<S extends string> {
  private showing = new Set<S>();
  private readonly expectedCounts = new Map<ScreenRule<S>, Map<string, number>>();

  constructor(private readonly rules: ScreenRule<S>[]) {}

  beginTurn(fullText: string): void {
    this.expectedCounts.clear();
    for (const rule of this.rules) {
      if (rule.scope !== 'new-occurrence') continue;
      this.expectedCounts.set(rule, countMatchingLines(rule.pattern, fullText));
    }
  }

  update(visibleText: string, fullText: string = visibleText): { appeared: S[]; visible: Set<S> } {
    const visible = new Set<S>();
    const appeared = new Set<S>();
    for (const rule of this.rules) {
      if (rule.scope === 'new-occurrence') {
        const expected = this.expectedCounts.get(rule) ?? new Map<string, number>();
        const current = countMatchingLines(rule.pattern, fullText);
        for (const line of new Set([...expected.keys(), ...current.keys()])) {
          const expectedCount = expected.get(line) ?? 0;
          const currentCount = current.get(line) ?? 0;
          if (currentCount < expectedCount) expected.set(line, currentCount);
          else if (currentCount > expectedCount) {
            appeared.add(rule.signal);
            expected.set(line, currentCount);
          }
        }
        this.expectedCounts.set(rule, expected);
        continue;
      }
      if (rule.pattern.test(visibleText)) visible.add(rule.signal);
    }
    for (const signal of visible) if (!this.showing.has(signal)) appeared.add(signal);
    this.showing = visible;
    return { appeared: [...appeared], visible };
  }
}

function countMatchingLines(pattern: RegExp, text: string): Map<string, number> {
  const flags = pattern.flags.replace(/[gy]/g, '');
  const linePattern = new RegExp(pattern.source, flags);
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    linePattern.lastIndex = 0;
    if (linePattern.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}
