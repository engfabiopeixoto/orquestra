# Painel de Qualidade do projeto

## Intenção

Os agentes escrevem cada vez mais código nos projetos abertos no Orquestra, e o usuário não tem como saber se esse código está ficando difícil de manter. O painel de Qualidade mede o projeto aberto com as cinco técnicas que hoje servem para isso: cobertura de testes, estrutura de dependências, complexidade, tamanho dos módulos e teste de mutação.

O usuário ainda não conhece essas técnicas e vai aprendê-las usando o painel. Por isso, cada número vem acompanhado do que significa, de por que importa e de como melhorar, em português simples.

Os agentes também consultam o painel (`orq quality`). Assim, o regente pode pedir que corrijam o que pioraram antes de dar a tarefa por encerrada.

Nada disso mede o código do próprio Orquestra; para isso existe `docs/pesquisa/qualidade-codigo.md`.

## Objetivos

1. Medir o projeto aberto sem instalar nada nele: tamanho, complexidade e dependências saem de análise estática feita pelo próprio Orquestra.
2. Mostrar cobertura e mutação quando o projeto já gera esses relatórios, e oferecer um agente para configurá-los quando não gera.
3. Ensinar cada métrica dentro do painel: definição curta, por que importa, limites usados e como melhorar.
4. Comparar com a medição anterior e destacar o que piorou nos arquivos alterados, que é o que o usuário revisa depois de uma entrega.
5. Expor o mesmo resultado aos agentes pelo `orq quality` e pela ferramenta MCP `quality`.

## Fora do escopo (v1)

- Linguagens que não sejam JavaScript/TypeScript (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`). Em projetos sem esses arquivos, o painel diz que "por enquanto só analisa JavaScript e TypeScript".
- Bloquear commits ou integrar com CI. O painel informa e não impede nada.
- Regras de arquitetura escritas pelo usuário (camadas permitidas). A v1 só detecta ciclos e acoplamento.
- Rodar teste de mutação pelo próprio Orquestra.

## Anti-objetivos (falha mesmo funcionando)

- Alterar o projeto do usuário sem pedido explícito: instalar dependências, criar configs ou rodar testes por conta própria.
- Travar a interface ou o host durante a análise de um projeto grande.
- Resumir tudo numa nota única que engana. Cada métrica tem o próprio sinal (verde, amarelo ou vermelho) e o motivo dele.
- Jargão sem explicação.

## Métricas e limites

Cada métrica mostra um sinal: verde (ok), amarelo (atenção) ou vermelho (problema). Os limites são os da avaliação feita no Orquestra, ajustados para iniciantes.

| Métrica | Como mede | Amarelo | Vermelho |
|---|---|---|---|
| **Tamanho** | Linhas de código de cada arquivo, sem linhas em branco e sem comentários | arquivo acima de 350 linhas | acima de 600 |
| **Complexidade** | Complexidade ciclomática de cada função (1 + cada `if`, `else if`, `case`, `for`, `while`, `do`, `catch`, `?:`, `&&`, `\|\|`, `??`) e a profundidade máxima de aninhamento | função acima de 10, ou aninhamento acima de 4 | função acima de 20 |
| **Dependências** | Grafo dos imports entre arquivos do próprio projeto: ciclos e fan-in/fan-out de cada arquivo | qualquer ciclo só de tipos (`import type`) | qualquer ciclo em tempo de execução |
| **Cobertura** | Leitura de um relatório que o projeto já gera | linhas abaixo de 70% | abaixo de 50% |
| **Mutação** | Leitura do relatório do Stryker | nota abaixo de 80% | abaixo de 60% |

Como o sinal de cada métrica é calculado:
- **Tamanho e complexidade:** vermelho se algum item está no vermelho; amarelo se algum está no amarelo.
- **Cobertura e mutação:** o total do projeto.

Os limites ficam numa tabela única no código (`QUALITY_LIMITS` em `shared`), usada tanto pelo painel quanto pelo texto explicativo.

### Hotspots

A lista principal do painel são os **pontos críticos**: arquivos grandes, complexos e alterados com frequência.
- Fórmula: `commits nos últimos 90 dias × soma da complexidade × linhas ÷ 100`.
- Os commits vêm de `git log` e são opcionais: sem git, a pontuação usa só tamanho × complexidade.
- Mostra os 10 primeiros, cada um com o motivo ("622 linhas, função `render` com complexidade 31, alterado 14 vezes").

### Arquivos considerados

- Quando o projeto tem git, entram os arquivos de `git ls-files --cached --others --exclude-standard`, o que respeita o `.gitignore`. Sem git, a busca percorre as pastas.
- Ficam sempre de fora: `node_modules`, `.git`, `.orquestra`, `dist`, `build`, `out`, `coverage`, `.next`, `reports`, arquivos `*.min.js` e `*.d.ts`.
- Arquivos de teste (`*.test.*`, `*.spec.*`, pastas `test`, `tests`, `__tests__`, `e2e`) contam no tamanho, mas aparecem separados e não entram nos hotspots.
- Limites de segurança: no máximo 5.000 arquivos, e arquivos acima de 1 MB são ignorados e contados como "pulados". O painel informa quando algum limite foi atingido.

## Cobertura e mutação: ler, não rodar

O Orquestra não roda testes por conta própria; ele lê relatórios que já existem no projeto.

**Cobertura**, na ordem de procura:
1. `coverage/coverage-summary.json` (Istanbul json-summary, gerado por Vitest e Jest);
2. `coverage/coverage-final.json`;
3. `coverage/lcov.info`.

O painel mostra:
- o total do projeto (linhas, branches, funções);
- os 10 arquivos com mais linhas descobertas;
- a data do relatório, com aviso "relatório antigo" quando ele é anterior à última alteração de código.

**Mutação:** `reports/mutation/mutation.json` (formato mutation-testing-report-schema do Stryker). O painel mostra a nota por arquivo e os mutantes sobreviventes, com arquivo, linha e mutação.

**Quando o relatório não existe**, o cartão explica a técnica e oferece o botão **"Pedir a um agente"**:
- O botão abre a escolha de um terminal de agente do workspace.
- O Orquestra envia ao agente um pedido pronto em pt-BR, como se fosse um `orq prompt`: configurar a cobertura no test runner que o projeto já usa, gerar `json-summary` em `coverage/` e rodar uma vez. Para mutação: configurar o Stryker só nos arquivos alterados e gerar o relatório JSON.
- O texto do pedido fica em `shared`, para ser testável.
- Quem altera o projeto é o agente, à vista do usuário, o que respeita o anti-objetivo de não mexer no projeto sem pedido.

## Comparação com a medição anterior

- Cada medição é salva em `.orquestra/quality/last.json`, e a anterior vai para `previous.json`.
- O painel mostra a variação de cada métrica (▲ piorou, ▼ melhorou).
- A seção **"Nos arquivos alterados"** lista só os arquivos que aparecem em `git status` e o que piorou neles: função nova acima do limite, arquivo que passou de 350 linhas, ciclo novo.

## Painel na interface

- Uma aba **Qualidade** na barra lateral, ao lado do explorador de arquivos do projeto.
- O botão **Medir** roda a análise. O resultado anterior aparece enquanto a nova roda, e não há medição automática na v1.
- Topo do painel: os cinco cartões de métrica, cada um com sinal, número principal, variação e um "?" que abre a explicação.
- Abaixo dos cartões: hotspots e "Nos arquivos alterados".
- Clicar num arquivo abre a pré-visualização que já existe no explorador.
- A explicação de cada métrica tem quatro partes curtas: **O que é**, **Por que importa**, **Limites usados aqui** e **Como melhorar**. Os textos ficam em `shared/quality-guide.ts`, o mesmo arquivo que alimenta `orq quality --explain`.

## Para os agentes

- `orq quality [--changed] [--explain <métrica>] [--json]`:
  - imprime um resumo em texto: sinais, hotspots e o que piorou;
  - `--changed` limita aos arquivos alterados;
  - roda a medição se a última tiver mais de 60 s.
- Ferramenta MCP `quality`, com os mesmos parâmetros.
- Linha nova no guia do regente (`regent.ts`): "Depois de implementar, rode `orq quality --changed` e corrija o que ficou vermelho antes de entregar."

## Onde fica cada parte (decisões minhas)

- **Análise:** módulo novo em `core` (`quality/`), com funções puras e testáveis:
  - `measureSize(text)`;
  - `measureComplexity(sourceFile)`;
  - `buildImportGraph(files)` + `findCycles` (Tarjan);
  - `readCoverage(dir)`;
  - `readMutation(dir)`;
  - `hotspots(...)`;
  - `compare(previous, current)`.
- **Parser:** a API do compilador do `typescript`, que vira dependência de `core` e entra no bundle do host. Ela entende TS, TSX e JS sem configuração. A resolução de imports cobre:
  - caminhos relativos, com as extensões e `index.*`;
  - os `paths` do `tsconfig.json` da raiz, quando existir.
- **Execução:**
  - a análise roda num processo filho do host, no mesmo padrão do `usage-worker.ts`, para não travar o host;
  - tempo limite de 120 s e cancelamento pelo PID do processo filho;
  - nunca mata processos por nome.
- **Protocolo:**
  - método `quality` no pipe do orq;
  - comando `quality.measure` / `quality.read` no host-protocol;
  - resultado validado por um schema zod em `shared/quality-schema.ts`, que dá tipagem de ponta a ponta.
- **Testes:**
  - unitários das funções puras, com fixtures de projetos pequenos (ciclo, função complexa, relatório de cobertura, relatório do Stryker);
  - um teste do comando `orq quality`;
  - um e2e simples abrindo a aba e medindo um projeto fixture.

## Deixado para quem implementa

- O visual dos cartões, seguindo o estilo existente (`styles.css`, cores de aviso já usadas no alerta da tag de modelo).
- O formato exato do texto do `orq quality`.
- Se a complexidade cognitiva entra junto com a ciclomática. Opcional na v1; se entrar, ganha uma linha na tabela de limites (amarelo > 15, vermelho > 30).
