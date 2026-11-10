# Qualidade do código: cobertura, dependências, complexidade, tamanho e mutação

Medido na `main` em `2cce769` (0.3.14), em 10/11/2026, em worktrees descartáveis. Escopo: `packages/*/src` (151 arquivos TS/TSX, 14.489 linhas de código sem comentários nem linhas em branco). Os testes e os e2e ficaram fora das métricas de produção.

## Resumo

| Métrica | Hoje | Leitura | Gate proposto |
|---|---|---|---|
| Fronteiras entre pacotes | 0 violações | A arquitetura está limpa: `shared` ← `core` ← `host`; `cli` e `app` dependem só de `shared` | Falha com qualquer violação |
| Ciclos de import | 0 em runtime, **1 contando os imports só de tipo** (`cli/src/mcp.ts` ↔ `cli/src/run.ts`) | Corrigir o ciclo de tipo e travar | Falha com qualquer ciclo, contando os imports só de tipo |
| Cobertura (linhas / branches / funções) | 77,2% / 82,2% / 79,8% | `core` e `shared` estão bem (93–99% das linhas); no `app` é 60%, e o main do Electron fica em 0% | Piso por pacote com ratchet |
| Complexidade ciclomática | 89,6% das 2.147 funções ≤ 5; 23 funções > 20 | Concentrada em poucos pontos: CLI, validação de fluxo, criação de terminal, hooks | Alerta > 15, falha > 30 nos arquivos alterados |
| Tamanho de módulo | Média 94 linhas; `bridge.ts` 922, `orquestra.ts` 556, `session.ts` 511 | Três arquivos concentram mudança e complexidade | Alerta > 350, falha > 600 para arquivos novos |
| Mutação (piloto em 5 módulos) | 70,6% no total, 81,7% nos mutantes cobertos | Linhas cobertas não querem dizer comportamento verificado: há asserts faltando em `usage-format` e `edge-activity` | Incremental em PR, só em `shared` e `core` |

Cobertura e mutação dizem se o teste existe e se ele verifica. Dependências, complexidade e tamanho dizem onde o código fica caro de mudar. O cruzamento das duas coisas aponta onde agir: código complexo, que muda muito e é mal verificado.

## 1. Cobertura de testes

`@vitest/coverage-v8@2.1.8` (compatível com o Vitest 2.1.8), `npx vitest run --coverage`: 103 arquivos de teste e 821 testes passaram, em 50,4 s, contra 37,0 s sem instrumentação (+36%).

| Pacote | Arquivos | Linhas | Branches | Funções |
|---|---:|---:|---:|---:|
| app | 81 | 60,4% | 78,8% | 62,6% |
| cli | 4 | 84,6% | 77,6% | 94,4% |
| core | 38 | 92,9% | 86,7% | 96,1% |
| host | 12 | 84,2% | 78,4% | 83,2% |
| shared | 16 | 98,7% | 86,2% | 94,1% |

Maior risco por `linhas × (1 − cobertura de branches)`:

| Arquivo | Linhas | Branches | Linhas cobertas |
|---|---:|---:|---:|
| app/src/main/index.ts | 255 | 0% | 0% |
| app/src/main/portal/portal-ipc.ts | 206 | 0% | 0% |
| app/src/renderer/src/App.tsx | 201 | 0% | 0% |
| app/src/main/portal/portal-manager.ts | 410 | 53% | 71% |
| app/src/renderer/src/terminal/TerminalNode.tsx | 214 | 12,5% | 29% |
| host/src/bridge.ts | 813 | 82% | 83% |
| app/src/renderer/src/portal/PortalNode.tsx | 379 | 64% | 83% |
| app/src/main/portal/portal-view.ts | 270 | 56% | 67% |
| host/src/flow-engine.ts | 329 | 69% | 88% |
| app/src/renderer/src/canvas/Canvas.tsx | 279 | 73% | 14% |

Nenhum teste atinge estes arquivos: main do Electron (`index.ts`, `log.ts`, `portal/index.ts`, `portal-ipc.ts`), `preload/index.ts`, `App.tsx`, `main.tsx`, `Palette.tsx`, `ZoomControl.tsx`, `GroupDialog.tsx`, `GroupMembersDialog.tsx`, `app/src/shared/bridge.ts`, `cli/src/bin.ts`, `host/src/main.ts` e `host/src/run.ts`.

**O que a cobertura não enxerga.** O main do Electron, o preload e a montagem completa do renderer são exercitados só pelos e2e do Playwright, que não entram no relatório. O host roda como processo filho em `host-process.test.ts`, e o V8 desse processo não é coletado. Por isso o "0%" do main e do `host/run.ts` é cegueira da medição, não ausência de teste. Dá para somar a cobertura dos e2e com `NODE_V8_COVERAGE` no main, CDP `Profiler.takePreciseCoverage` no renderer e `c8`/`v8-to-istanbul` com os sourcemaps do electron-vite. O custo é alto (normalizar caminhos, coordenar o encerramento); vale só se a cobertura do `app` virar meta.

**Uso proposto.** Gerar `coverage/coverage-summary.json` no CI e comparar com pisos por pacote. O Vitest 2 só tem limite global, então a comparação por pacote é um script de cerca de 30 linhas. Pisos iniciais logo abaixo do medido (linhas/branches/funções): app 60/78/62, cli 84/77/94, core 92/86/96, host 84/78/83, shared 98/86/94. O ratchet sobe o piso quando o valor medido passa dele em 1 ponto. Para o `app`, a métrica útil é a cobertura dos módulos puros extraídos (`wheel.ts`, `edge-activity.ts`, `codex-input.ts`, `portal-protocol.ts`), não a do componente React.

## 2. Estrutura de dependências

`dependency-cruiser` 18.7.2 sobre 185 módulos e 523 arestas, em 4,8 s.

| De \ para | shared | core | host | app |
|---|---:|---:|---:|---:|
| core | 16 | — | 0 | 0 |
| cli | 3 | 0 | 0 | 0 |
| host | 9 | 5 | — | 0 |
| app (renderer 19, main 5) | 24 | 0 | 0 | — |

- **Instabilidade I = Ce/(Ca+Ce), por módulos:** shared 0, core 0,17, host, cli e app 1. As dependências sempre apontam para o mais estável, como pede o Princípio das Dependências Estáveis.
- **O renderer não importa** main, host, core nem módulos nativos do Node. Tudo passa pelo preload e pelos tipos de `shared`.
- **Ciclos:** nenhum em runtime. Com `tsPreCompilationDeps: true` (conta os `import type`) aparece **`cli/src/mcp.ts → cli/src/run.ts → mcp.ts`**. Não quebra em execução, mas acopla os dois arquivos. A correção é mover os tipos compartilhados para um terceiro módulo.
- **Maior fan-in:** `shared/src/index.ts` (33), `renderer/store.ts` (24), `renderer/api.ts` (11). O `store.ts` é o ponto de acoplamento do renderer: tudo que muda nele afeta 24 módulos.
- **Maior fan-out:** `App.tsx` (22), `Canvas.tsx` (21), `TerminalNode.tsx` (17), `core/orquestra.ts` (14).

**Uso proposto.** `.dependency-cruiser.cjs` com 7 regras (no-circular, shared-at-base, core-independent, cli-independent, host-independent-of-app-or-cli, renderer-no-node-backend, renderer-no-node-builtins), **com `tsPreCompilationDeps: true`**. É o gate mais barato e com menos ruído: ele trava a arquitetura que já está boa, e hoje só aponta o ciclo de tipo.

## 3. Complexidade ciclomática e cognitiva

ESLint (`complexity`) e `eslint-plugin-sonarjs` (`cognitive-complexity`), 2.147 funções, em 4,2 s.

| Faixa | Ciclomática | Cognitiva |
|---|---:|---:|
| 1–5 | 1.923 (89,6%) | 1.947 (90,7%) |
| 6–10 | 142 (6,6%) | 106 (4,9%) |
| 11–20 | 59 (2,7%) | 57 (2,7%) |
| > 20 | 23 (1,1%) | 37 (1,7%) |

| Função | Ciclom. | Cognit. | Linhas | Leitura |
|---|---:|---:|---:|---|
| `cli/src/run.ts:93` `execute` | 47 | 54 | 101 | `switch` de comandos; aceitável se cada `case` for curto. Uma tabela de comandos baixaria para menos de 10 |
| `shared/src/flow-contract.ts:24` `checkSchema` | 46 | 60 | 28 | Validação recursiva densa, em 28 linhas: o maior risco de bug por linha |
| `core/src/orquestra.ts:200` `spawnTerminal` | 39 | 45 | 84 | Monta args, ambiente, PTY e listeners de uma vez |
| `app/src/main/portal/browser-agent.ts:8` `browserDocument` | 36 | 49 | 38 | Script injetado na página; sem cobertura útil |
| `host/src/flow-engine.ts:152` `executeGraph` | 32 | 65 | 50 | Aninhamento de 6 níveis, o mais profundo do repositório |
| `host/src/flow-engine.ts:238` `compute` | 33 | 47 | 40 | Avaliação dos nós embutidos |
| `shared/src/flow-contract.ts:4` `validateFlowSchema` | 32 | 42 | 19 | — |
| `core/src/session.ts:235` `handleHook` | 30 | 34 | 83 | Ramifica por tipo de sinal dos três agentes |
| `renderer/portal/PortalNode.tsx:32` `PortalNode` | 30 | 25 | 401 | Componente de 401 linhas |
| `renderer/store.ts:173` `applyEvent` | 29 | 41 | 62 | Reducer de todos os eventos do host |
| `core/src/session.ts:165` `userInput` | 27 | 40 | 43 | — |

A ciclomática dá o número mínimo de casos de teste. A cognitiva mede o custo de leitura e é melhor para gate: um `switch` plano (`execute`) pontua alto na ciclomática, mas é fácil de ler, enquanto `checkSchema` e `executeGraph` são difíceis de verdade.

**Uso proposto.** Gate só nas funções alteradas no PR, com cognitiva > 15 alertando e > 30 falhando. As 37 funções acima de 20 ficam numa lista de exceções que só pode diminuir. `max-depth` 4 e `max-params` 4 como alerta.

## 4. Tamanho dos módulos e pontos críticos

| Pacote | Arquivos | Linhas de código | Média |
|---|---:|---:|---:|
| app | 84 | 6.791 | 81 |
| core | 38 | 3.897 | 103 |
| host | 12 | 2.222 | 185 |
| shared | 16 | 1.175 | 73 |
| cli | 4 | 404 | 101 |

Ponto crítico = commits nos últimos 90 dias × complexidade acumulada × linhas de código ÷ 100:

| # | Arquivo | Linhas | Commits (90d) | Complexidade acumulada | Máxima | Pontuação |
|---|---|---:|---:|---:|---:|---:|
| 1 | host/src/bridge.ts | 922 | 9 | 326 | 14 | 27.051 |
| 2 | core/src/orquestra.ts | 556 | 12 | 222 | 39 | 14.812 |
| 3 | core/src/session.ts | 511 | 11 | 217 | 30 | 12.198 |
| 4 | core/src/codex-rollout-watcher.ts | 462 | 5 | 190 | 24 | 4.389 |
| 5 | core/src/ask-broker.ts | 312 | 7 | 118 | 12 | 2.577 |
| 6 | renderer/canvas/Canvas.tsx | 326 | 5 | 154 | 12 | 2.510 |
| 7 | main/portal/portal-manager.ts | 447 | 3 | 177 | 26 | 2.374 |
| 8 | renderer/store.ts | 339 | 5 | 125 | 29 | 2.119 |
| 9 | renderer/terminal/TerminalNode.tsx | 245 | 9 | 96 | 23 | 2.117 |

`bridge.ts` não tem nenhuma função muito complexa (máxima 14); o problema dele é ser um `startHostBridge` de cerca de 820 linhas que fecha sobre tudo (workspace, regente, portal, uso, fluxo, processos). Em `orquestra.ts` e `session.ts` o problema é o contrário: poucas funções concentram a complexidade, em arquivos que mudam a cada feature (a tag de modelo e o `orq usage` passaram pelos três).

## 5. Mutation testing

StrykerJS 10.1.1 com o runner do Vitest, piloto em 5 módulos (339 linhas, 50 testes, 2 min 59 s, concorrência 2).

| Módulo | Nota | Mortos | Sobreviventes | Sem cobertura |
|---|---:|---:|---:|---:|
| shared/src/models.ts | 76,8% | 73 | 21 | 1 |
| shared/src/usage-format.ts | 66,1% | 80 | 36 | 5 |
| core/src/user-input.ts | 95,0% | 19 | 1 | 0 |
| renderer/terminal/wheel.ts | 97,5% | 79 | 2 | 0 |
| renderer/canvas/edge-activity.ts | 39,8% | 35 | 4 | 49 |

Sobreviventes que apontam testes faltando:
- `edge-activity.ts:27–39`: o caminho de respostas (`answeredEdgeActivity`) não tem teste unitário próprio; ele só é exercitado indiretamente em `use-edge-activity.test.tsx`, que ficou fora dos testes do piloto. Parte dos 49 mutantes sem cobertura vem desse recorte; os que sobrarem com a suíte completa pedem testes diretos da função pura.
- `usage-format.ts:7`: o limite "renova agora" (`diffMs <= 0`) e a fronteira de 24 h não são verificados. O formatador é recente (`orq usage`) e tem a nota mais baixa entre os módulos com cobertura.
- `user-input.ts:5`: aceita a mutação que limita o código SGR do mouse a um dígito. Falta um caso com código de vários dígitos (roda = 64/65).
- `wheel.ts:36,74`: ninguém confere `preventDefault`/`stopPropagation` do evento repassado.
- `models.ts:72,109`: a comparação de modelos (aliases, sufixo de data) tem saídas que os asserts não distinguem. Ela acende o alerta vermelho da tag, então é onde um falso positivo aparece para o usuário.

**Custo.** O repositório inteiro levaria de 1,5 a 4 h, o que não é viável por PR. Por PR, o `--mutate` só nos arquivos alterados de `shared` e `core` leva de segundos a poucos minutos. Atenção: `--incremental` reaproveita resultados, mas não seleciona arquivos; quem passa a lista de arquivos é o CI.

## 6. Plano recomendado

Em ordem de retorno por esforço:

1. **dependency-cruiser no CI** (5 s, 0 falso positivo hoje). Antes, corrigir o ciclo de tipo `mcp.ts` ↔ `run.ts`.
2. **Cobertura com piso por pacote e ratchet** (+13 s no `npm test`), excluindo do relatório o main do Electron e o preload, para o número não esconder a cegueira.
3. **ESLint de complexidade só no diff** (cognitiva > 15 alerta, > 30 falha) e lista de exceções para as 37 funções acima de 20.
4. **Mutação incremental nos PRs que tocam `shared` e `core`**, com nota mínima de 80% nos arquivos alterados. Sem gate na UI, no main do Electron nem no host com processos.
5. **Refatoração guiada pelos pontos críticos**, quando uma feature passar por eles (sem projeto à parte):
   - `bridge.ts`: extrair os grupos de comandos de `startHostBridge` (regente, uso, workspace, portal, fluxo) em fábricas que recebem um contexto. Cada uma passa a ter teste próprio.
   - `orquestra.ts`: tirar de `spawnTerminal` a montagem do lançamento (args, ambiente, modelo de partida) como função pura testável.
   - `session.ts`: `handleHook` vira uma tabela por `signal.kind`.
   - `flow-contract.ts` `checkSchema` e `flow-engine.ts` `executeGraph`: primeiros alvos de mutação, porque são o código mais denso e um bug silencioso neles corrompe o fluxo.

## Reprodução

```bash
# Arquitetura e ciclos (contando imports só de tipo)
npx depcruise --config .dependency-cruiser.cjs --output-type err packages/shared/src packages/core/src packages/cli/src packages/host/src packages/app/src
# Complexidade
npx eslint packages/*/src --ext .ts,.tsx
# Cobertura
npx vitest run --coverage
# Mutação em arquivos escolhidos
npx stryker run --mutate "packages/shared/src/models.ts,packages/shared/src/usage-format.ts" --incremental
# Mudanças nos últimos 90 dias
git log --numstat --since="90 days ago" -- "packages/*/src/**"
```

As configurações usadas na medição (`.dependency-cruiser.cjs`, `.eslintrc.cjs`, `vitest.config.ts` com coverage, `stryker.config.mjs`) estão nos worktrees `orquestra-q1` e `orquestra-q2`, prontas para entrar no repositório.
