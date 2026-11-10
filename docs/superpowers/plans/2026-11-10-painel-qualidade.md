# Plano de implementação do Painel de Qualidade

> **Para agentes:** sub-skill obrigatória: superpowers:executing-plans. Execute tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** medir o projeto JS/TS aberto no Orquestra em cinco métricas (tamanho, complexidade, dependências, cobertura e mutação). O resultado aparece num painel que ensina cada métrica e também está disponível aos agentes pelo `orq quality`.

**Arquitetura:**
- A análise estática fica em `packages/core/src/quality/` e usa a API do compilador `typescript`. As funções são puras e testáveis.
- O host roda a análise num processo filho (`host.mjs --quality <dir>`), guarda a última medição em `.orquestra/quality/` e expõe:
  - comandos `quality.*` para o renderer;
  - o método `quality` para o pipe do orq.
- O contrato inteiro é um schema zod em `shared`.

**Stack:** TypeScript 5.7.2 (API do compilador), zod 3.24.1, React 19, Vitest 2.1.8, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-painel-qualidade-design.md`

## Restrições globais

- Todo texto para o usuário é em pt-BR. Commits em pt-BR, no modo indicativo, sem prefixo.
- Limites (vêm do spec e ficam só em `QUALITY_LIMITS`):
  - arquivo: amarelo acima de 350 linhas, vermelho acima de 600;
  - função: amarelo acima de complexidade 10, vermelho acima de 20; aninhamento amarelo acima de 4;
  - ciclo: amarelo se só de tipos, vermelho se em tempo de execução;
  - cobertura de linhas: amarelo abaixo de 70%, vermelho abaixo de 50%;
  - mutação: amarelo abaixo de 80%, vermelho abaixo de 60%.
- Extensões analisadas: `.js .jsx .mjs .cjs .ts .tsx .mts .cts`. Ficam fora `*.d.ts` e `*.min.js`.
- Pastas sempre ignoradas: `node_modules .git .orquestra dist build out coverage .next reports`.
- Testes: `*.test.*`, `*.spec.*` e as pastas `test`, `tests`, `__tests__` e `e2e`. Contam no tamanho e ficam fora dos hotspots e do sinal de complexidade.
- Limites de segurança:
  - no máximo 5.000 arquivos;
  - arquivos acima de 1 MB são pulados e contados;
  - processo filho com tempo limite de 120 s.
- Hotspot: `commits90d × sumComplexity × loc ÷ 100`. Sem git, `commits90d` vale 1. Os 10 maiores, só de arquivos que não são de teste.
- Snapshot: `.orquestra/quality/last.json`. Ao medir de novo, o anterior vira `previous.json`.
- O Orquestra nunca roda testes, nunca instala nada e nunca grava fora de `.orquestra/quality/` no projeto do usuário.
- Processos: nunca encerrar por nome, só pelo PID do processo filho que o próprio host criou.
- Não tocar nas mudanças não commitadas de `packages/core` (`ask-broker.ts`, `handlers.ts` e os testes delas) no checkout principal. As tarefas rodam em worktrees.
- O pedido a um agente é **uma linha só**, sem `\n`, porque é digitado na TUI pelo `session.sendCommand`.

## Pontos de atenção na revisão

1. Arquivo com erro de sintaxe ou encoding estranho: o parser do TS é tolerante. A medição continua e o arquivo entra normalmente. Teste na Tarefa 2.
2. Relatório de cobertura com caminhos absolutos do Windows (`E:\\proj\\src\\a.ts`), barras invertidas e letra de unidade em outra caixa: precisa casar com os arquivos do projeto. Teste na Tarefa 3.
3. Projeto sem git, ou pasta que não é repositório: medição completa, com `commits90d = null` e `changed` vazio. Teste na Tarefa 4.
4. Projeto sem nenhum arquivo JS/TS (só Python, por exemplo): `language: 'unsupported'` e o painel mostra a mensagem do spec, sem erro. Testes nas Tarefas 4 e 6.
5. Medir de novo enquanto uma medição roda: as duas chamadas reaproveitam a mesma promessa e não sobem dois processos filhos. Teste na Tarefa 5.

---

### Tarefa 1: Contrato, limites e textos em `shared`

**Arquivos:**
- Criar:
  - `packages/shared/src/quality-schema.ts`
  - `packages/shared/src/quality-guide.ts`
  - `packages/shared/src/quality-format.ts`
- Modificar:
  - `packages/shared/src/index.ts` (exportar os três)
  - `packages/shared/src/protocol.ts` (método `quality`)
- Teste: `packages/shared/test/quality.test.ts`

**Interfaces:**
- Produz (`quality-schema.ts`):

```ts
export const QUALITY_LIMITS = {
  fileLoc: { warn: 350, bad: 600 }, complexity: { warn: 10, bad: 20 }, depth: { warn: 4 },
  coverageLines: { warn: 70, bad: 50 }, mutationScore: { warn: 80, bad: 60 },
} as const;
export const QUALITY_METRICS = ['size', 'complexity', 'dependencies', 'coverage', 'mutation'] as const;
export type QualityMetricId = typeof QUALITY_METRICS[number];
export type QualitySignal = 'ok' | 'warn' | 'bad' | 'missing';
// Schemas zod (com o tipo inferido de mesmo nome sem "Schema"):
qualityFileSchema      { path: string /* relativo, com "/" */; loc: number; test: boolean; functions: number; maxComplexity: number; sumComplexity: number; maxDepth: number; fanIn: number; fanOut: number; commits90d: number | null }
qualityFunctionSchema  { path; line: number /* 1-based */; name: string; complexity: number; depth: number; loc: number }
qualityCycleSchema     { files: string[]; typeOnly: boolean }
coverageReportSchema   { source: 'summary'|'final'|'lcov'; generatedAt: string /* ISO */; stale: boolean; lines: number; branches: number|null; functions: number|null; files: { path: string; lines: number; uncovered: number }[] /* top 10 por uncovered */ }
mutationReportSchema   { generatedAt: string; score: number; files: { path; score: number; killed: number; survived: number; noCoverage: number }[]; survivors: { path; line: number; mutator: string; replacement: string }[] /* máx 50 */ }
qualityMetricSchema    { id: QualityMetricId; signal: 'ok'|'warn'|'bad'|'missing'; value: number|null; delta: number|null }
qualityHotspotSchema   { path; score: number; reason: string }
qualityChangeSchema    { path; kind: 'function-over-limit'|'file-over-limit'|'new-cycle'; detail: string }
qualityReportSchema    { version: 1; dir: string; measuredAt: string; durationMs: number; language: 'js-ts'|'unsupported';
                         limits: { files: number; skippedLarge: number; truncated: boolean };
                         metrics: QualityMetric[] /* sempre os 5, na ordem de QUALITY_METRICS */;
                         files: QualityFile[]; functions: QualityFunction[] /* as acima de complexity.warn + as 20 maiores */;
                         cycles: QualityCycle[]; hotspots: QualityHotspot[]; changed: QualityChange[];
                         coverage: CoverageReport|null; mutation: MutationReport|null }
qualityParamsSchema    { changed?: boolean; refresh?: boolean }
export function signalFor(id: QualityMetricId, value: number | null, extra?: { typeOnlyCycles?: number; maxDepth?: number }): QualitySignal;
```

Significado de `value` em cada métrica:
- `size`: linhas do maior arquivo que não é de teste;
- `complexity`: maior complexidade entre as funções que não são de teste;
- `dependencies`: número de ciclos em tempo de execução;
- `coverage`: % de linhas;
- `mutation`: nota.

`delta` = `value` atual − `value` anterior, ou `null` quando não há medição anterior.

- Produz (`quality-guide.ts`): `QUALITY_GUIDE: Record<QualityMetricId, { title: string; what: string; why: string; limits: string; improve: string }>`.
  - Textos em pt-BR, de 1 a 3 frases cada, sem jargão sem explicação.
  - `limits` é montado a partir de `QUALITY_LIMITS`, nunca com números digitados à mão.
- Produz (`quality-guide.ts`): `qualityAgentPrompt(kind: 'coverage' | 'mutation', report: QualityReport | null): string`.
  - Retorna uma linha só, sem `\n`.
  - Para `coverage`: pede para configurar a cobertura no test runner que o projeto já usa, com saída `json-summary` em `coverage/`, rodar uma vez e não mudar código de produção.
  - Para `mutation`: pede para configurar o StrykerJS com o runner do projeto, mutando só os arquivos de `report.changed` (ou os 3 primeiros hotspots, se `changed` estiver vazio), gerar `reports/mutation/mutation.json` e rodar uma vez.
- Produz (`quality-format.ts`): `formatQualitySummary(report: QualityReport, opts: { changed: boolean }): string`, o texto do `orq quality`:
  - uma linha por métrica: sinal (`OK`, `ATENÇÃO`, `PROBLEMA` ou `SEM DADOS`), valor e delta;
  - depois os hotspots, ou só `changed` quando `opts.changed`;
  - no fim, a dica `orq quality --explain <métrica>`.
- Produz (`quality-format.ts`): `formatQualityExplain(id: QualityMetricId): string`.
- Produz (`protocol.ts`): método `quality: { params: qualityParamsSchema, result: qualityReportSchema }`.

- [ ] **Passo 1:** escrever os testes em `packages/shared/test/quality.test.ts`:
  - `signalFor`:
    - `('size', 351)` → `'warn'`;
    - `('size', 601)` → `'bad'`;
    - `('size', 350)` → `'ok'`;
    - `('complexity', 21)` → `'bad'`;
    - `('coverage', 69.9)` → `'warn'`;
    - `('coverage', 49)` → `'bad'`;
    - `('mutation', 80)` → `'ok'`;
    - `('mutation', null)` → `'missing'`;
    - `('dependencies', 0, { typeOnlyCycles: 1 })` → `'warn'`;
    - `('dependencies', 1)` → `'bad'`;
    - `('complexity', 8, { maxDepth: 5 })` → `'warn'`.
  - `qualityAgentPrompt` não contém `\n` nos dois tipos, e o de mutação cita o caminho de `changed[0].path`.
  - Cada `QUALITY_GUIDE[id].limits` contém os números de `QUALITY_LIMITS` daquela métrica.
  - `formatQualitySummary` de um relatório fixture contém `PROBLEMA` para um arquivo de 700 linhas e não contém `undefined`.
  - `qualityReportSchema.parse` aceita o fixture.
- [ ] **Passo 2:** rodar `npx vitest run packages/shared/test/quality.test.ts`. Esperado: FALHA (módulos inexistentes).
- [ ] **Passo 3:** implementar os três arquivos, as exportações e o método no protocolo.
- [ ] **Passo 4:** rodar `npx vitest run packages/shared` e `npx tsc -p packages/shared --noEmit`. Esperado: PASSA.
- [ ] **Passo 5:** commit: "Define o contrato, os limites e as explicações do painel de Qualidade".

### Tarefa 2: Tamanho e complexidade (análise de um arquivo)

**Arquivos:**
- Criar: `packages/core/src/quality/source-metrics.ts`
- Modificar: `packages/core/package.json` (dependência `"typescript": "5.7.2"`)
- Teste: `packages/core/test/quality-source.test.ts`

**Interfaces:**
- Consome: os tipos `QualityFunction` e `QualityFile` da Tarefa 1.
- Produz:

```ts
export interface ImportRef { specifier: string; typeOnly: boolean }
export interface SourceMetrics { loc: number; functions: Omit<QualityFunction, 'path'>[]; imports: ImportRef[] }
export function analyzeSource(fileName: string, text: string): SourceMetrics;
```

Regras:
- **`loc`:** linhas que têm pelo menos um token que não é trivia. Usar `ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, variant por extensão)` e marcar a linha do início e do fim de cada token. Template literals e strings multilinha contam em todas as linhas.
- **Funções:** `FunctionDeclaration`, `FunctionExpression`, `ArrowFunction`, `MethodDeclaration`, `Constructor`, `GetAccessor` e `SetAccessor`. Cada uma é medida sozinha: os desvios de uma função interna não somam na externa.
- **Complexidade:** 1 + `IfStatement`, `ConditionalExpression`, `CaseClause` (o `default` não conta), `ForStatement`, `ForInStatement`, `ForOfStatement`, `WhileStatement`, `DoStatement`, `CatchClause`, mais cada `BinaryExpression` com operador `&&`, `||` ou `??`.
- **`depth`:** maior aninhamento de `if`, laços, `switch`, `try` e `catch` dentro da função. Começa em 0; um `if` dentro de um `for` dá 2. O `else if` não aumenta a profundidade.
- **`name`:**
  1. o nome da declaração;
  2. senão, o nome da variável ou propriedade que recebe a função;
  3. senão, `constructor`;
  4. senão, `(anônima)`.
- **`line`:** linha da função, começando em 1.
- **`loc` da função:** a mesma regra de `loc` aplicada ao trecho da função.
- **`imports`:**
  - `import ... from`, `export ... from`, `import('x')` com string literal e `require('x')` com string literal;
  - `typeOnly` é verdadeiro em `import type` e `export type`, ou quando todos os especificadores nomeados são `type`.
- **Tipo do script:** `ScriptKind` pela extensão (TSX para `.tsx` e `.jsx`).

- [ ] **Passo 1:** testes:
  - Função vazia: complexidade 1 e `depth` 0.
  - `if (a && b) {} else if (c) {} ` + `x ?? y` + `for…{ if… }`: complexidade calculada à mão (= 6) e `depth` 2.
  - `switch` com 3 `case` e um `default`: 4.
  - Arrow dentro de função: duas entradas, e a externa não soma os desvios da interna.
  - `const handler = () => {}`: `name` é `'handler'`.
  - `loc` de um texto com 3 linhas de código, 2 em branco, um bloco `/* */` de 3 linhas e uma linha `// x`: 3.
  - `import type { A } from './a'` e `import { type B } from './b'`: `typeOnly` verdadeiro; `import { C } from './c'`: falso; `require('./d')` e `import('./e')` aparecem.
  - Arquivo com erro de sintaxe (`function (`): não lança exceção e retorna `loc > 0` (ponto de atenção 1).
- [ ] **Passo 2:** `npx vitest run packages/core/test/quality-source.test.ts`. Esperado: FALHA.
- [ ] **Passo 3:** `npm install typescript@5.7.2 -w packages/core --save-exact` e implementar `analyzeSource`.
- [ ] **Passo 4:** a mesma execução do Passo 2. Esperado: PASSA.
- [ ] **Passo 5:** commit: "Mede tamanho e complexidade de cada arquivo JS/TS do projeto".

### Tarefa 3: Grafo de imports, ciclos e leitura dos relatórios

**Arquivos:**
- Criar:
  - `packages/core/src/quality/import-graph.ts`
  - `packages/core/src/quality/reports.ts`
- Testes:
  - `packages/core/test/quality-graph.test.ts`
  - `packages/core/test/quality-reports.test.ts`
  - fixtures em `packages/core/test/fixtures/quality/`

**Interfaces:**
- Consome: `ImportRef` (Tarefa 2) e os tipos da Tarefa 1.
- Produz:

```ts
export interface PathAliases { baseUrl: string; paths: Record<string, string[]> } // relativos à raiz, com "/"
export function readPathAliases(dir: string): Promise<PathAliases | null>; // tsconfig.json da raiz; JSON com comentários via ts.parseConfigFileTextToJson
export function resolveImport(from: string, specifier: string, files: ReadonlySet<string>, aliases: PathAliases | null): string | null;
export interface ImportGraph { edges: Map<string, Map<string, boolean /* typeOnly */>>; fanIn: Map<string, number>; fanOut: Map<string, number> }
export function buildImportGraph(imports: Map<string, ImportRef[]>, files: ReadonlySet<string>, aliases: PathAliases | null): ImportGraph;
export function findCycles(graph: ImportGraph): QualityCycle[];
export function readCoverage(dir: string, files: ReadonlySet<string>, newestSourceMtimeMs: number): Promise<CoverageReport | null>;
export function readMutation(dir: string, files: ReadonlySet<string>): Promise<MutationReport | null>;
```

Regras:
- **`resolveImport`:** só especificadores relativos ou que casem com algum alias. Tenta o caminho exato, depois cada extensão analisada e depois `/index.<ext>`. Um import `.js` que aponta para um `.ts` (o padrão ESM do TS) resolve para o `.ts`. Pacotes externos retornam `null`.
- **Aresta `typeOnly`:** só é verdadeira se todos os imports entre o mesmo par de arquivos forem de tipo.
- **`findCycles`:**
  - roda Tarjan só nas arestas de execução: cada componente fortemente conexo (SCC) com mais de um arquivo (ou um arquivo que importa a si mesmo) vira um ciclo com `typeOnly: false`;
  - depois roda Tarjan em todas as arestas: cada SCC que não contém nenhum arquivo de um ciclo de execução vira um ciclo com `typeOnly: true`;
  - `files` vem ordenado.
- **`readCoverage`:**
  - procura, nesta ordem, `coverage/coverage-summary.json`, `coverage/coverage-final.json` (Istanbul: conta `s` para linhas, `b` para branches e `f` para funções) e `coverage/lcov.info` (`LF/LH`, `BRF/BRH`, `FNF/FNH`);
  - normaliza os caminhos dos arquivos: absoluto → relativo à raiz, `\` → `/`, sem diferenciar a caixa da letra da unidade, e descarta os que ficam fora de `files`;
  - `generatedAt` vem do mtime do relatório, e `stale` é `mtime < newestSourceMtimeMs`;
  - `files`: os 10 com mais linhas descobertas;
  - se o JSON for inválido, retorna `null` e registra no log, sem lançar exceção.
- **`readMutation`:**
  - lê `reports/mutation/mutation.json` (`files[path].mutants[].status`);
  - a nota é `killed + timeout` dividido por `killed + timeout + survived + noCoverage`, × 100, com uma casa decimal;
  - `survivors` traz até 50 mutantes com status `Survived`: `location.start.line`, `mutatorName` e `replacement`.

- [ ] **Passo 1:** testes de grafo:
  - `a.ts → b.ts → a.ts` (execução): um ciclo `{files:['a.ts','b.ts'], typeOnly:false}`.
  - `c.ts ⇄ d.ts` só por `import type`: `typeOnly: true`.
  - `./x.js` resolve para `x.ts`; `./dir` resolve para `dir/index.tsx`; com alias `@/*: ['src/*']`, `@/u` resolve para `src/u.ts`; `react` resolve para `null`.
  - fanIn e fanOut de um grafo de 3 nós.
- [ ] **Passo 2:** testes de relatórios, com fixtures:
  - um `coverage-summary.json` com chave absoluta `E:\\proj\\src\\a.ts` e `e:/proj/src/b.ts`, e dir `E:\\proj`: os dois arquivos casam (ponto de atenção 2);
  - total de linhas igual a `lines.pct` do item `total`;
  - `lcov.info` mínimo com `LF:10 LH:7`: 70;
  - relatório mais antigo que `newestSourceMtimeMs`: `stale: true`;
  - JSON corrompido: `null`;
  - `mutation.json` com 3 mortos, 1 sobrevivente e 1 sem cobertura: nota 60 e um sobrevivente com a linha certa.
- [ ] **Passo 3:** `npx vitest run packages/core/test/quality-graph.test.ts packages/core/test/quality-reports.test.ts`. Esperado: FALHA.
- [ ] **Passo 4:** implementar os dois módulos.
- [ ] **Passo 5:** a mesma execução do Passo 3. Esperado: PASSA.
- [ ] **Passo 6:** commit: "Detecta ciclos de import e lê os relatórios de cobertura e mutação do projeto".

### Tarefa 4: Medição do projeto inteiro e comparação

**Arquivos:**
- Criar:
  - `packages/core/src/quality/measure.ts`
  - `packages/core/src/quality/index.ts` (reexporta)
- Modificar: `packages/core/src/index.ts`
- Teste: `packages/core/test/quality-measure.test.ts`, com projetos temporários criados em `os.tmpdir()`

**Interfaces:**
- Consome: as Tarefas 1, 2 e 3.
- Produz:

```ts
export function listProjectFiles(dir: string): Promise<{ files: string[]; skippedLarge: number; truncated: boolean }>;
export function gitChurn(dir: string): Promise<Map<string, number> | null>; // git log --since=90.days --name-only --pretty=format:
export function gitChanged(dir: string): Promise<Set<string> | null>;      // git status --porcelain=v1 -z, inclui não rastreados
export function hotspots(files: QualityFile[]): QualityHotspot[];
export function compareReports(previous: QualityReport | null, current: Omit<QualityReport, 'changed'>, changed: Set<string> | null): { metrics: QualityMetric[]; changed: QualityChange[] };
export function measureProject(dir: string): Promise<QualityReport>;
export function readLastReport(dir: string): Promise<QualityReport | null>;  // .orquestra/quality/last.json validado pelo schema; inválido → null
export function saveReport(dir: string, report: QualityReport): Promise<void>; // last → previous, grava last
```

Regras:
- **`listProjectFiles`:**
  - num repositório git, usa `git ls-files --cached --others --exclude-standard -z`; senão, percorre as pastas;
  - aplica as pastas ignoradas e as extensões das Restrições globais;
  - corta em 5.000 (`truncated`) e pula os arquivos acima de 1 MB (`skippedLarge`);
  - o git roda como em `ProjectFiles.git()` (`project-files.ts`), com `GIT_OPTIONAL_LOCKS=0`, `windowsHide` e tempo limite de 10 s; se falhar, a função trata como projeto sem git.
- **`measureProject`:** sem nenhum arquivo, retorna `language: 'unsupported'`, as 5 métricas como `missing` e as listas vazias.
- **`reason` de cada hotspot:** frase como `"622 linhas, função render com complexidade 31, alterado 14 vezes em 90 dias"`. Sem git, a parte dos commits sai da frase.
- **`compareReports`:**
  - calcula `delta` por métrica;
  - `changed` só para arquivos em `changed`:
    - `function-over-limit`: função com complexidade acima de `complexity.warn` que não existia acima do limite antes (casar por `path` e `name`);
    - `file-over-limit`: arquivo que passou de `fileLoc.warn`;
    - `new-cycle`: ciclo que contém o arquivo e não existia antes;
  - sem relatório anterior, todas as violações dos arquivos alterados entram em `changed`.
- **`measureProject` não grava nada.** Quem chama decide se chama `saveReport`.

- [ ] **Passo 1:** testes:
  - Projeto temporário com `src/big.ts` (700 linhas de código), `src/a.ts ⇄ src/b.ts`, `src/a.test.ts` e `node_modules/x/index.js`:
    - `size` é `bad` com valor 700;
    - `dependencies` é `bad` com valor 1;
    - `node_modules` fica de fora;
    - o teste aparece com `test: true` e fica fora dos hotspots.
  - Projeto sem git: `commits90d` nulo e `changed` vazio (ponto de atenção 3).
  - Pasta só com `main.py`: `language: 'unsupported'` (ponto de atenção 4).
  - `compareReports` com o anterior com `big.ts` de 300 linhas e o atual com 400, e `big.ts` alterado: um `file-over-limit` e `delta` +100.
  - `saveReport` duas vezes: `previous.json` tem o primeiro.
  - `readLastReport` com JSON inválido: `null`.
- [ ] **Passo 2:** `npx vitest run packages/core/test/quality-measure.test.ts`. Esperado: FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npx vitest run packages/core` e `npx tsc -p packages/core --noEmit`. Esperado: PASSA.
- [ ] **Passo 5:** commit: "Mede o projeto inteiro, acha os pontos críticos e compara com a medição anterior".

### Tarefa 5: Host: processo filho, comandos e método do pipe

**Arquivos:**
- Modificar:
  - `packages/host/src/main.ts` (ramo `--quality <dir>`)
  - `packages/host/build.ts` (`'typescript'` em `EXTERNAL_MODULES`)
  - `packages/host/src/bridge.ts`
  - `packages/shared/src/host-protocol.ts`
  - `packages/core/src/orquestra.ts` (opção `quality`)
  - `packages/core/src/handlers.ts` (método `quality`)
- Criar: `packages/host/src/quality-worker.ts`
- Testes:
  - `packages/host/test/quality-worker.test.ts`
  - caso novo em um teste de handlers do core, em arquivo novo `packages/core/test/quality-handler.test.ts`, para não mexer em `orquestra.test.ts`

**Interfaces:**
- Consome: `measureProject`, `readLastReport` e `saveReport` (Tarefa 4); `qualityAgentPrompt` (Tarefa 1); `session.sendCommand(text)` (já existe, `session.ts:363`).
- Produz (`host-protocol.ts`):
  - `'quality.read': { params: empty, result: z.object({ report: qualityReportSchema.nullable() }) }`
  - `'quality.measure': { params: empty, result: qualityReportSchema }`
  - `'quality.ask': { params: z.object({ name: z.string().min(1), kind: z.enum(['coverage','mutation']) }), result: empty }`
- Produz (`quality-worker.ts`): `measureQualityIsolated(opts: { script: string; dir: string; signal: AbortSignal; onStart(pid: number): void; onExit(pid: number): void }): Promise<QualityReport>`.
  - Segue o padrão de `readAgyUsageIsolated` em `usage-worker.ts`: `spawn(process.execPath, [script, '--quality', dir])`, tempo limite de 120 s, encerramento por PID com `taskkill /PID <pid> /T /F` e saída validada por `qualityReportSchema`.
  - O limite da saída é 32 MB, não os 64 KB do worker de uso.
- Produz (`orquestra.ts` / `handlers.ts`): opção `quality?: (params: { changed?: boolean; refresh?: boolean }) => Promise<QualityReport>`.
  - Sem a opção, o método `quality` lança `OrqError('APP_UNAVAILABLE', 'A medição de qualidade precisa do app do Orquestra.')`.
  - Com `changed`, o handler devolve o relatório como está, e a CLI formata.

Regras do bridge:
- Uma função `measureQuality(force: boolean)`:
  - reaproveita a promessa pendente para o mesmo `project.dir` (ponto de atenção 5);
  - com `force` falso, devolve `last.json` se tiver menos de 60 s;
  - senão, mede no processo filho, aplica `compareReports` com `readLastReport`, chama `saveReport` e devolve o relatório.
- Os PIDs do filho entram em `recordPids` como `usagePids`.
- Abortar a medição quando o projeto for fechado ou trocado.
- `quality.measure` = `measureQuality(true)`.
- O `quality` do pipe usa `measureQuality(params.refresh === true)`.
- `quality.ask`:
  - `orquestra.session(name)`; se não existir, `NOT_FOUND`;
  - `sendCommand(qualityAgentPrompt(kind, await readLastReport(dir)))`;
  - registra no log `{ terminal, kind }`.
- Sem projeto aberto, os três comandos lançam o erro de `requireProject()`.

Observação: `compareReports` roda no host, depois do filho, porque precisa do `previous`. O filho devolve o relatório com `changed: []` e `delta: null`.

- [ ] **Passo 1:** testes:
  - Worker: o script de um processo fake que imprime um relatório válido resolve; JSON inválido rejeita com uma mensagem em pt-BR; o abort encerra o filho pelo PID.
  - Handler: `quality` sem a opção lança `APP_UNAVAILABLE`; com a opção, repassa `{changed:true}`.
  - Bridge: duas chamadas `quality.measure` simultâneas sobem o filho uma vez só. Usar o padrão de teste do bridge que já existe, com o `script` injetável.
- [ ] **Passo 2:** rodar os testes novos. Esperado: FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test` na raiz. Esperado: PASSA, salvo os testes instáveis já conhecidos `host-process` e `flow-engine` (EBUSY). Depois `node packages/host/pack.ts` (ou o script de pack que já existe) e confirmar que `typescript` aparece em `dist-pack/package.json`.
- [ ] **Passo 5:** commit: "Roda a medição de qualidade num processo à parte e a expõe ao app e aos agentes".

### Tarefa 6: `orq quality`, ferramenta MCP e guia do regente

**Arquivos:**
- Modificar:
  - `packages/cli/src/run.ts` (o `case 'quality'` e a linha no HELP)
  - `packages/cli/src/mcp.ts`
  - `packages/shared/src/regent.ts`
- Teste: o arquivo de teste da CLI que já existe para `usage` (seguir o mesmo padrão com client fake).

**Interfaces:**
- Consome: o método `quality` (Tarefa 5) e `formatQualitySummary` / `formatQualityExplain` (Tarefa 1).
- Produz:
  - CLI: `orq quality [--changed] [--refresh] [--explain <métrica>] [--json]`.
    - `--explain` não chama o pipe e só imprime `formatQualityExplain`.
    - Métrica desconhecida gera `OrqError('USAGE', 'Métrica desconhecida. Use: size, complexity, dependencies, coverage ou mutation.')`.
  - MCP: `tool('quality', 'Mede a qualidade do código do projeto aberto (tamanho, complexidade, ciclos de import, cobertura e mutação). Use depois de implementar, com changed=true, e corrija o que ficou vermelho.', { changed: { type: 'boolean' }, refresh: { type: 'boolean' } }, [], true)`.
  - Linha no `regentGuide` e no `orquestraGuide`: `'Depois de implementar, rode orq quality --changed e corrija o que ficou vermelho antes de entregar.'`

- [ ] **Passo 1:** testes:
  - `orq quality --changed` chama `quality` com `{changed:true}` e imprime o texto formatado;
  - `--explain coverage` não chama o client;
  - `--explain xyz` lança `USAGE`;
  - `ORQUESTRA_TOOLS` contém `quality` com `readOnlyHint` verdadeiro;
  - `regentGuide()` contém `orq quality --changed`.
- [ ] **Passo 2:** rodar os testes. Esperado: FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test` na raiz. Esperado: PASSA.
- [ ] **Passo 5:** commit: "Deixa os agentes medirem a qualidade com orq quality".

### Tarefa 7: Aba Qualidade na barra lateral

**Arquivos:**
- Criar:
  - `packages/app/src/renderer/src/components/QualityPanel.tsx`
  - `packages/app/src/renderer/src/components/QualityMetricCard.tsx`
- Modificar:
  - `packages/app/src/renderer/src/canvas/Sidebar.tsx:133` (abas "Arquivos" e "Qualidade" no lugar do explorador direto)
  - `packages/app/src/renderer/src/components/ProjectFileExplorer.tsx` (prop opcional `openPath?: string | null` que abre a pré-visualização desse arquivo)
  - `packages/app/src/renderer/src/styles.css`
- Testes:
  - `packages/app/test/quality-panel.test.tsx`
  - `packages/app/e2e/quality.spec.ts`

**Interfaces:**
- Consome:
  - `api.command('quality.read' | 'quality.measure' | 'quality.ask', …)` (Tarefa 5);
  - `QUALITY_GUIDE`, `QUALITY_LIMITS` e os tipos (Tarefa 1).
- Produz: `QualityPanel({ api, projectDir, terminals, onOpenFile }: { api: CommandApi; projectDir: string; terminals: { name: string; agent: string }[]; onOpenFile(path: string): void })`.

Comportamento:
- Ao montar, chama `quality.read`.
- O botão **Medir** chama `quality.measure`. Enquanto mede, o resultado anterior continua visível, aparece "Medindo…" e o botão fica desabilitado.
- **Cartões:** os 5, na ordem de `QUALITY_METRICS`.
  - Cada um mostra o título do guia, o sinal por cor e texto (para não depender só da cor), o valor, o delta (▲ piorou / ▼ melhorou, com a direção certa por métrica: em cobertura e mutação, subir é melhorar) e o botão `?`.
  - O `?` expande `what`, `why`, `limits` e `improve`.
- **Cobertura ou mutação `missing`:** o cartão mostra o `what` e o botão "Pedir a um agente". O botão abre a lista dos `terminals` com agente diferente de `shell` e chama `quality.ask`. Sem agentes, o botão fica desabilitado com o título "Abra um terminal de agente".
- **`language: 'unsupported'`:** só a mensagem "Por enquanto o painel só analisa projetos JavaScript e TypeScript."
- **Listas:**
  - "Nos arquivos alterados" (`changed`), quando não vazia;
  - "Pontos críticos" (`hotspots`);
  - "Ciclos de import";
  - "Funções mais complexas" (top 10).
  - Clicar num caminho chama `onOpenFile`. No Sidebar, isso volta para a aba Arquivos com `openPath`.
- **`limits.truncated` ou `skippedLarge`:** aviso discreto no rodapé.
- **Erros do comando:** aparecem como `usage-error`, como no explorador.

- [ ] **Passo 1:** testes de componente (Testing Library, com `api` fake):
  - renderiza os 5 cartões a partir de um relatório fixture;
  - cobertura `missing` mostra "Pedir a um agente";
  - com um terminal `codex`, a escolha chama `quality.ask` com `{name, kind:'coverage'}`;
  - `unsupported` mostra a mensagem;
  - clicar num hotspot chama `onOpenFile` com o caminho;
  - delta de cobertura +5 mostra "melhorou".
- [ ] **Passo 2:** rodar os testes. Esperado: FALHA.
- [ ] **Passo 3:** implementar o painel, as abas e o `openPath`.
- [ ] **Passo 4:** e2e `quality.spec.ts`, no padrão de `file-explorer.spec.ts`:
  - abre um projeto temporário com `src/a.ts ⇄ src/b.ts`;
  - vai à aba Qualidade e clica em Medir;
  - espera o cartão Dependências com o texto de problema.
- [ ] **Passo 5:** `npm test` na raiz e `npm run e2e -w packages/app -- quality.spec.ts`. Esperado: PASSA.
- [ ] **Passo 6:** commit: "Mostra a aba Qualidade com as métricas explicadas e o pedido a um agente".

---

## Ordem e paralelismo

| Rodada | Tarefas | Por quê |
|---|---|---|
| 1 | Tarefa 1 | É o contrato de todas as outras |
| 2 | Tarefas 2→3→4 (dev3-codex) ‖ Tarefa 7 (dev2-agy) | Arquivos disjuntos. A UI depende só do schema e usa fixtures |
| 3 | Tarefas 5 e 6 | Ligam o core ao host, à CLI e à UI |

Cada rodada roda num worktree próprio criado a partir de `feat/qualidade`. O maestro revisa, roda `npm test` e faz o commit.
