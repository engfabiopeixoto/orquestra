import {
  QUALITY_LIMITS,
  type QualityChange,
  type QualityMetricId,
  type QualityRefactorTarget,
  type QualityReport,
} from './quality-schema.js';

export type QualityGuideEntry = {
  title: string;
  what: string;
  why: string;
  limits: string;
  improve: string;
};

/** Explicações em português simples para cada métrica, compartilhadas entre painel e CLI. */
export const QUALITY_GUIDE: Record<QualityMetricId, QualityGuideEntry> = {
  size: {
    title: 'Tamanho dos módulos',
    what: 'Conta as linhas reais de código de cada arquivo, deixando de fora linhas em branco e comentários.',
    why: 'Arquivos muito longos misturam vários assuntos ao mesmo tempo. Isso dificulta encontrar regras e aumenta a chance de quebrar algo sem querer.',
    limits: `Ok até ${QUALITY_LIMITS.fileLoc.warn} linhas; atenção acima de ${QUALITY_LIMITS.fileLoc.warn}; problema acima de ${QUALITY_LIMITS.fileLoc.bad} linhas.`,
    improve: 'Separe responsabilidades em arquivos menores com nomes claros. Comece extraindo helpers puros ou partes independentes.',
  },
  complexity: {
    title: 'Complexidade',
    what: 'Mede quantos caminhos diferentes existem dentro de uma função (cada if, laço, catch ou operador lógico soma um caminho) e quantos blocos estão aninhados uns dentro dos outros.',
    why: 'Funções com muitos desvios e aninhamentos exigem guardar muitos casos na cabeça para entender e testar. Elas costumam concentrar bugs sutis.',
    limits: `Ok até complexidade ${QUALITY_LIMITS.complexity.warn} e aninhamento ${QUALITY_LIMITS.depth.warn}; atenção acima de complexidade ${QUALITY_LIMITS.complexity.warn} ou aninhamento ${QUALITY_LIMITS.depth.warn}; problema acima de complexidade ${QUALITY_LIMITS.complexity.bad}.`,
    improve: 'Retorne cedo nos casos simples para reduzir o aninhamento. Quebre ramos longos em funções pequenas com nomes que expliquem o que verificam.',
  },
  dependencies: {
    title: 'Dependências',
    what: 'Mapeia quais arquivos importam quais e procura ciclos, quando um grupo de arquivos depende em círculo uns dos outros.',
    why: 'Imports em círculo criam acoplamento forte e podem causar valores indefinidos na inicialização. Também tornam difícil testar ou reaproveitar um módulo isolado.',
    limits: 'Ok sem ciclos; atenção quando há ciclo apenas de tipos (import type); problema quando existe qualquer ciclo em tempo de execução.',
    improve: 'Extraia tipos ou funções compartilhadas para um terceiro arquivo sem volta. Em último caso, inverta a dependência passando callbacks ou interfaces.',
  },
  coverage: {
    title: 'Cobertura de testes',
    what: 'Lê o relatório gerado pelo seu executor de testes e mostra qual porcentagem das linhas do código foi executada durante os testes.',
    why: 'Linhas nunca executadas nos testes podem esconder erros que só aparecem quando um usuário passa por aquele caminho. A cobertura aponta esses pontos cegos.',
    limits: `Ok a partir de ${QUALITY_LIMITS.coverageLines.warn}%; atenção abaixo de ${QUALITY_LIMITS.coverageLines.warn}%; problema abaixo de ${QUALITY_LIMITS.coverageLines.bad}%.`,
    improve: 'Escreva testes primeiro para os arquivos mais críticos e com mais linhas descobertas. Cubra casos de erro e borda além do caminho feliz.',
  },
  mutation: {
    title: 'Teste de mutação',
    what: 'Lê o relatório do StrykerJS, que faz pequenas alterações automáticas no código (mutantes) para ver se os testes falham como deveriam.',
    why: 'Um teste pode passar por uma linha sem verificar o resultado de verdade. A nota de mutação mostra se os testes realmente detectam bugs.',
    limits: `Ok a partir de ${QUALITY_LIMITS.mutationScore.warn}%; atenção abaixo de ${QUALITY_LIMITS.mutationScore.warn}%; problema abaixo de ${QUALITY_LIMITS.mutationScore.bad}%.`,
    improve: 'Olhe os mutantes sobreviventes listados no relatório e adicione asserções que verifiquem o valor exato de saída ou o efeito esperado.',
  },
};

/** Monta um pedido de uma linha para o agente configurar cobertura ou mutação sem alterar código de produção. */
export function qualityAgentPrompt(kind: 'coverage' | 'mutation', report: QualityReport | null): string {
  if (kind === 'coverage') {
    return 'Configure a cobertura de testes no test runner que este projeto já usa para gerar o formato json-summary na pasta coverage/, rode os testes com cobertura uma vez e não altere o código de produção.';
  }

  const changedPaths = [...new Set((report?.changed ?? []).map((item) => item.path))];
  const targetPaths = changedPaths.length > 0
    ? changedPaths
    : (report?.hotspots ?? []).slice(0, 3).map((item) => item.path);
  const scope = targetPaths.length > 0
    ? `mutando apenas estes arquivos: ${targetPaths.join(', ')}`
    : 'mutando apenas os arquivos principais de código-fonte';

  return singleLine(
    `Configure o StrykerJS usando o test runner que este projeto já usa, ${scope}, para gerar o relatório JSON em reports/mutation/mutation.json, rode uma vez e não altere o código de produção.`,
  );
}

const MAX_REFACTOR_PROMPT_CHARS = 1200;
const REFACTOR_RULES =
  'Regras: não mude comportamento nem API pública; se o arquivo tiver pouca ou nenhuma cobertura escreva testes de caracterização antes de mexer; todos os testes existentes precisam passar; mexa só no alvo e no estritamente necessário; rode orq quality --changed --refresh no fim e informe o antes/depois; não faça commit e entregue para revisão.';

function singleLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function normalizeQualityPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function pathKey(path: string): string {
  return normalizeQualityPath(path).toLowerCase();
}

function cycleSetKey(files: readonly string[]): string {
  return [...new Set(files.map(pathKey))].sort().join('\0');
}

export function sameRefactorCycle(a: readonly string[], b: readonly string[]): boolean {
  return cycleSetKey(a) === cycleSetKey(b);
}

function parseChangedFunction(item: QualityChange): { name: string; line: number } | null {
  const match = /^Função\s+(.+?)\s+\(linha\s+(\d+)\)/.exec(item.detail);
  return match ? { name: match[1]!, line: Number(match[2]) } : null;
}

/** Resolve o alvo de refatoração no formato canônico do último relatório, ou retorna `null`. */
export function resolveQualityRefactorTarget(
  report: QualityReport | null,
  target: QualityRefactorTarget,
): QualityRefactorTarget | null {
  if (!report || report.language !== 'js-ts') return null;
  switch (target.type) {
    case 'file': {
      const key = pathKey(target.path);
      const file = report.files.find((item) => pathKey(item.path) === key);
      if (file) return { type: 'file', path: file.path };
      const spot = report.hotspots.find((item) => pathKey(item.path) === key);
      if (spot) return { type: 'file', path: spot.path };
      const changed = report.changed.find((item) => pathKey(item.path) === key);
      return changed ? { type: 'file', path: changed.path } : null;
    }
    case 'function': {
      const key = pathKey(target.path);
      const fn = report.functions.find(
        (item) => pathKey(item.path) === key && item.name === target.name && item.line === target.line,
      );
      if (fn) return { type: 'function', path: fn.path, name: fn.name, line: fn.line };
      const changed = report.changed.find((item) => {
        if (item.kind !== 'function-over-limit' || pathKey(item.path) !== key) return false;
        const parsed = parseChangedFunction(item);
        return parsed?.name === target.name && parsed?.line === target.line;
      });
      return changed ? { type: 'function', path: changed.path, name: target.name, line: target.line } : null;
    }
    case 'cycle': {
      const cycle = report.cycles.find((item) => sameRefactorCycle(item.files, target.files));
      return cycle ? { type: 'cycle', files: cycle.files } : null;
    }
  }
}

/** Verifica se o alvo de refatoração existe no último relatório medido. */
export function hasQualityRefactorTarget(report: QualityReport | null, target: QualityRefactorTarget): boolean {
  return resolveQualityRefactorTarget(report, target) !== null;
}

export type QualityRefactorChoice = { target: QualityRefactorTarget; label: string };

/** Seleciona o pior alvo de uma métrica para o botão de refatoração do cartão. */
export function worstRefactorTarget(metricId: QualityMetricId, report: QualityReport): QualityRefactorChoice | null {
  const testPaths = new Set(report.files.filter((file) => file.test).map((file) => pathKey(file.path)));

  if (metricId === 'size') {
    const nonTest = report.files.filter((file) => !file.test);
    const largest = [...nonTest].sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path))[0];
    if (largest) return { target: { type: 'file', path: largest.path }, label: largest.path };
    if (report.files.length > 0) return null;
    const spot = report.hotspots.find((item) => !testPaths.has(pathKey(item.path)));
    if (spot) return { target: { type: 'file', path: spot.path }, label: spot.path };
    const changedFile = report.changed.find((item) => item.kind === 'file-over-limit' && !testPaths.has(pathKey(item.path)));
    return changedFile ? { target: { type: 'file', path: changedFile.path }, label: changedFile.path } : null;
  }
  if (metricId === 'complexity') {
    const candidates = report.functions.filter((fn) => !testPaths.has(pathKey(fn.path)));
    if (candidates.length === 0) return null;
    const violates = (fn: (typeof candidates)[number]) =>
      fn.complexity > QUALITY_LIMITS.complexity.warn || fn.depth > QUALITY_LIMITS.depth.warn;
    const hasComplexityOverWarn = candidates.some((fn) => fn.complexity > QUALITY_LIMITS.complexity.warn);
    const fn = [...candidates].sort((a, b) => {
      const va = violates(a) ? 1 : 0;
      const vb = violates(b) ? 1 : 0;
      if (va !== vb) return vb - va;
      if (!hasComplexityOverWarn) {
        return b.depth - a.depth || b.complexity - a.complexity || b.loc - a.loc;
      }
      return b.complexity - a.complexity || b.depth - a.depth || b.loc - a.loc;
    })[0];
    return fn ? { target: { type: 'function', path: fn.path, name: fn.name, line: fn.line }, label: `${fn.name} (${fn.path}:${fn.line})` } : null;
  }
  if (metricId === 'dependencies') {
    const cycle = report.cycles.find((item) => !item.typeOnly) ?? report.cycles[0];
    return cycle ? { target: { type: 'cycle', files: cycle.files }, label: cycle.files.join(' ↔ ') } : null;
  }
  return null;
}

/** Resolve o alvo de refatoração de um item da lista "Nos arquivos alterados". */
export function changedItemRefactorTarget(item: QualityChange, report: QualityReport): QualityRefactorChoice | null {
  const key = pathKey(item.path);
  if (item.kind === 'file-over-limit') {
    return { target: { type: 'file', path: item.path }, label: item.path };
  }
  if (item.kind === 'function-over-limit') {
    const parsed = parseChangedFunction(item);
    if (parsed) {
      const fn = report.functions.find(
        (f) => pathKey(f.path) === key && f.name === parsed.name && f.line === parsed.line,
      );
      if (fn) {
        return { target: { type: 'function', path: fn.path, name: fn.name, line: fn.line }, label: `${fn.name} (${fn.path}:${fn.line})` };
      }
      return { target: { type: 'function', path: item.path, name: parsed.name, line: parsed.line }, label: `${parsed.name} (${item.path}:${parsed.line})` };
    }
    const topFn = [...report.functions].filter((f) => pathKey(f.path) === key).sort((a, b) => b.complexity - a.complexity)[0];
    return topFn
      ? { target: { type: 'function', path: topFn.path, name: topFn.name, line: topFn.line }, label: `${topFn.name} (${topFn.path}:${topFn.line})` }
      : { target: { type: 'file', path: item.path }, label: item.path };
  }
  if (item.kind === 'new-cycle') {
    const cycle =
      report.cycles.find((c) => c.files.some((f) => pathKey(f) === key) && item.detail.includes(c.files.join(' ↔ '))) ??
      report.cycles.find((c) => !c.typeOnly && c.files.some((f) => pathKey(f) === key)) ??
      report.cycles.find((c) => c.files.some((f) => pathKey(f) === key));
    return cycle ? { target: { type: 'cycle', files: cycle.files }, label: cycle.files.join(' ↔ ') } : null;
  }
  return null;
}

function formatCycleList(files: readonly string[], maxChars: number): string {
  const full = files.join(' -> ');
  if (full.length <= maxChars) return full;
  const kept: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const rem = files.length - kept.length;
    const suffix = ` (+${rem} ${rem === 1 ? 'arquivo' : 'arquivos'})`;
    const next = kept.length === 0 ? files[i]! : `${kept.join(' -> ')} -> ${files[i]!}`;
    const nextRem = files.length - (kept.length + 1);
    const nextSuffix = nextRem > 0 ? ` (+${nextRem} ${nextRem === 1 ? 'arquivo' : 'arquivos'})` : '';
    if (kept.length >= 2 && next.length + nextSuffix.length > maxChars) {
      return `${kept.join(' -> ')}${suffix}`;
    }
    kept.push(files[i]!);
  }
  return full.slice(0, maxChars);
}

/** Monta pedido de refatoração em uma linha (máx. ~1200 chars) para um único alvo. */
export function qualityRefactorPrompt(target: QualityRefactorTarget, report: QualityReport | null): string {
  let intro = '';
  if (target.type === 'function') {
    const key = pathKey(target.path);
    const fn = report?.functions.find(
      (item) => pathKey(item.path) === key && item.name === target.name && item.line === target.line,
    );
    const measure = fn
      ? `tem complexidade ${fn.complexity}${fn.depth > QUALITY_LIMITS.depth.warn ? ` e aninhamento ${fn.depth}` : ''}`
      : 'está acima dos limites';
    intro = `Refatore apenas o alvo: a função ${target.name} em ${target.path}:${target.line} ${measure}; o limite vermelho é ${QUALITY_LIMITS.complexity.bad}, o amarelo ${QUALITY_LIMITS.complexity.warn} (aninhamento até ${QUALITY_LIMITS.depth.warn}). Traga para abaixo de ${QUALITY_LIMITS.complexity.warn} e aninhamento até ${QUALITY_LIMITS.depth.warn} (ou ao menos ${QUALITY_LIMITS.complexity.bad}) extraindo funções coesas.`;
  } else if (target.type === 'file') {
    const key = pathKey(target.path);
    const file = report?.files.find((item) => pathKey(item.path) === key);
    const measure = file ? `tem ${file.loc} linhas` : 'está acima do limite de tamanho';
    intro = `Refatore apenas o alvo: o arquivo ${target.path} ${measure}; o limite vermelho é ${QUALITY_LIMITS.fileLoc.bad}, o amarelo ${QUALITY_LIMITS.fileLoc.warn}. Divida em módulos coesos mantendo os exports atuais para ficar abaixo de ${QUALITY_LIMITS.fileLoc.warn} linhas (ou ao menos ${QUALITY_LIMITS.fileLoc.bad}).`;
  } else {
    const cycle = report?.cycles.find((item) => sameRefactorCycle(item.files, target.files));
    const kindText = cycle?.typeOnly ? 'só de tipos' : 'em execução';
    const fixedOverhead = 210;
    const filesBudget = Math.max(80, MAX_REFACTOR_PROMPT_CHARS - REFACTOR_RULES.length - fixedOverhead);
    const filesText = formatCycleList(target.files, filesBudget);
    intro = `Refatore apenas o alvo: o ciclo de import ${kindText} entre ${filesText} (limite: 0 ciclos; ciclo em execução é vermelho, só de tipos é amarelo). Quebre o ciclo movendo tipos compartilhados ou invertendo dependências sem mudar comportamento.`;
  }

  const combined = singleLine(`${intro} ${REFACTOR_RULES}`);
  if (combined.length <= MAX_REFACTOR_PROMPT_CHARS) return combined;
  const introBudget = Math.max(80, MAX_REFACTOR_PROMPT_CHARS - REFACTOR_RULES.length - 4);
  return singleLine(`${singleLine(intro).slice(0, introBudget)}… ${REFACTOR_RULES}`).slice(0, MAX_REFACTOR_PROMPT_CHARS);
}
