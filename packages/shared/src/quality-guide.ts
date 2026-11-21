import { QUALITY_LIMITS, type QualityMetricId, type QualityReport } from './quality-schema.js';

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

  return `Configure o StrykerJS usando o test runner que este projeto já usa, ${scope}, para gerar o relatório JSON em reports/mutation/mutation.json, rode uma vez e não altere o código de produção.`;
}
