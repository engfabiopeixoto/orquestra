# Canvas como painel de telemetria — fatia 1: arestas vivas e moldura por estado

## Objetivo

Hoje o estado dos agentes só aparece no badge de texto do cabeçalho (`ocioso`, `ocupado · 1 na fila`), e todas as arestas têm o mesmo peso visual. A fatia 1 move essa leitura para sinais periféricos: a aresta mostra quem está conversando com quem e em que sentido, e a moldura do card mostra o estado do agente sem precisar de zoom.

Critério de sucesso: com o canvas afastado, dá para saber, sem ler texto, quais agentes trabalham, qual espera o usuário, qual encerrou e qual par de agentes troca pedidos agora.

## Fora do escopo

- Fatia 2: HUD "🔔 N aguardando você" com pan/zoom e pílulas de status no cabeçalho do grupo.
- Fatia 3: spotlight no hover (precisa de histórico recente de pedidos).
- Partículas/cometas nas arestas e borda de gradiente rotativo.
- Estado de erro com shake: não há sinal de erro além de `exited`.
- Contador de tempo ocupado.
- Mudanças no host ou no protocolo de eventos.

## Fonte dos dados

Tudo vem do que o renderer já recebe:

- `terminals[name].state`: `starting | idle | busy | waiting | exited`.
- `queues[target]: QueueEntry[]`, com `from`, `status: 'queued' | 'running'` e `kind: 'prompt' | 'delivery'` (`packages/shared/src/host-protocol.ts`). `prompt` é delegação; `delivery` é a resposta voltando a quem pediu.

As arestas são não direcionadas (`{ a, b }`). A direção sai da fila: uma entrada em `queues[b]` com `from === a` é fluxo `a→b`.

## Componentes

### `canvas/edge-activity.ts` — função pura

```ts
export type EdgeActivity = { flow: 'a→b' | 'b→a' | 'both'; kind: 'prompt' | 'delivery'; running: boolean };
export function edgeActivity(edges: EdgeView[], queues: Record<string, QueueEntry[]>): Map<string, EdgeActivity>;
```

- Chave do mapa: o id da aresta (`${a}--${b}`, o mesmo de `buildClosestEdges`).
- Para cada aresta, coleta as entradas de `queues[b]` com `from === a` e de `queues[a]` com `from === b`. Sem entradas, a aresta fica fora do mapa.
- `flow`: `both` quando há entradas nos dois sentidos.
- A entrada representativa, que define `kind` e `running`, é a primeira com `status === 'running'`; se nenhuma estiver em curso, é a mais antiga (primeira na ordem da fila).

### `canvas/use-edge-activity.ts` — hook

- Lê `edges` e `queues` da store e chama `edgeActivity`.
- Quando uma aresta sai do mapa, mantém o último valor por 3 s (`LINGER_MS = 3000`), com `running: false`, e só então a remove. Se a aresta voltar a ter atividade nesse intervalo, o timer é cancelado.
- Limpa os timers no unmount.

### `buildClosestEdges`

Recebe o mapa de atividade e põe `data.activity` em cada aresta. A aresta continua sem direção própria; `source` e `target` seguem sendo `a` e `b`.

### `RemovableEdge`

- Classes no grupo da aresta: `orq-edge--active` quando há atividade, `orq-edge--running` quando `running`, `orq-edge--reverse` quando `flow === 'b→a'`, `orq-edge--both` quando `flow === 'both'`.
- Pílula no ponto médio (`EdgeLabelRenderer`): `⚡ delegando` para `prompt`, `📩 retornando` para `delivery`. Em hover ou seleção, o botão × de desconectar aparece e a pílula se esconde.

### `TerminalNode`

Classe `frame-<estado>` no container do card. O xterm não recebe opacidade nem filtro. No estado `waiting`, aparece o badge `👋 aguardando você` no topo do card. No `busy` com movimento contido, um spinner substitui a bolinha.

### Configuração

- `settingsSchema.canvas` ganha `motion: z.enum(['contained', 'minimal']).default('contained')`. Configs salvas sem o campo continuam válidas.
- `SettingsDialog` ganha o seletor "Animações do canvas" com as opções "Contido" e "Mínimo".
- O container do canvas recebe `data-motion="contained" | "minimal"`.
- `@media (prefers-reduced-motion: reduce)` aplica as regras do mínimo independentemente da configuração.

## Visual

### Arestas

| Situação | Contido | Mínimo |
|---|---|---|
| Sem atividade | opacidade 0.25; hover e seleção com destaque total | igual |
| Na fila | laranja (`--acc`), opacidade 1, sem animação | igual |
| Em curso, um sentido | tracejado animado via `stroke-dashoffset` no sentido do destino; `--reverse` inverte a animação | laranja sólido, `stroke-width: 3`, sem animação |
| Em curso, `both` | laranja aceso, sem animação | igual ao mínimo de um sentido |

### Cards

| Estado | Contido | Mínimo |
|---|---|---|
| `idle` | borda `#2a2e37`, sem brilho, cabeçalho esmaecido | igual |
| `busy` | barra indeterminada de 2px no topo + spinner | borda `--busy` + bolinha |
| `waiting` | borda âmbar (`--wait`) com `box-shadow` pulsando a cada 1.5 s + badge | borda âmbar com glow fixo + badge |
| `exited` | borda vermelha sólida com glow | igual |
| `starting` | sem mudança | sem mudança |

## Testes

- Vitest, `edgeActivity`: fila vazia; `a→b`; `b→a`; `both`; prioridade da entrada em curso sobre a mais antiga; `prompt` versus `delivery`; fila de um terceiro terminal não acende a aresta.
- Vitest, `useEdgeActivity` com timers falsos: a atividade permanece 3 s depois que a fila esvazia, perde `running` nesse intervalo e o timer é cancelado se a atividade volta.
- Vitest, `settingsSchema`: config sem `canvas.motion` vira `contained`.
- Vitest de render, `RemovableEdge`: classes por atividade, texto da pílula, pílula escondida em hover.
- Vitest de render, `TerminalNode`: classe `frame-<estado>` e badge em `waiting`.
- E2E: enviar um pedido entre dois terminais conectados e conferir `orq-edge--active` na aresta.
