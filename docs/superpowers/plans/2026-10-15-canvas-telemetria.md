# Canvas como painel de telemetria — fatia 1 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arestas que acendem e animam no sentido do pedido entre agentes, com pílula de contexto, e moldura do card de terminal que mostra o estado do agente; tudo com um modo de movimento "Contido" ou "Mínimo" nas configurações.

**Architecture:** Uma função pura deriva a atividade de cada aresta da fila (`queues`) que o renderer já recebe; um hook segura a atividade por 3 s depois que a fila esvazia. `buildClosestEdges` transforma a atividade em classes e `data`; o `RemovableEdge` desenha a pílula; o `TerminalNode` ganha a classe `frame-<estado>`. Toda a animação é CSS, ligada pelo atributo `data-motion` no `.react-flow` e desligada por `prefers-reduced-motion`.

**Tech Stack:** React 18, @xyflow/react, zustand, zod, Vitest + Testing Library (jsdom), Playwright/Electron para e2e.

**Spec:** `docs/superpowers/specs/2026-10-15-canvas-telemetria-design.md`

## Global Constraints

- Nenhuma mudança no host, no core (exceto testes de settings) ou no protocolo de eventos.
- `settingsSchema.canvas.motion`: `z.enum(['contained', 'minimal']).default('contained')`; configs sem o campo continuam válidas.
- Rótulos da UI em pt-BR: "Animações do canvas", "Contido", "Mínimo", `⚡ delegando`, `📩 retornando`, `👋 aguardando você`.
- Atraso da atividade depois que a fila esvazia: `LINGER_MS = 3000`.
- O xterm (`.term-content`, `.term-body`) nunca recebe opacidade, filtro ou animação.
- Animações só dentro de `@media (prefers-reduced-motion: no-preference)` e sob `[data-motion="contained"]`; o visual "Mínimo" é a base estática.
- Cores pelos tokens existentes em `styles.css`: `--acc` (arestas), `--busy`, `--wait`, `--danger`. O "aguardando você" usa `--wait` (o azul que a bolinha já usa), não um âmbar novo, para card e bolinha terem a mesma cor.
- Mensagens de commit em pt-BR, frase no indicativo, sem prefixo (padrão do repositório); nunca mencionar "Claude Code".

## Review Focus

1. Troca de workspace com aresta acesa: a atividade do workspace anterior não pode aparecer, nem por 3 s, numa aresta de mesmo nome no novo workspace (teste na Task 3, parâmetro `scope`).
2. Aresta removida ou terminal renomeado enquanto a atividade ainda está no atraso: o mapa pode ter id órfão, que não deve gerar aresta (teste na Task 4).
3. Aresta selecionada ou em hover durante atividade: o destaque de seleção e o × de desconectar continuam funcionando, e a pílula some para não cobrir o × (teste na Task 4).
4. Pedido entre dois terminais sem aresta entre eles, ou fila de um terceiro terminal: nenhuma aresta acende (teste na Task 2).
5. Pedido que volta a ficar ativo durante o atraso de 3 s: o timer é cancelado e a aresta não apaga no meio do pedido novo (teste na Task 3).

---

## Mapa de arquivos

- Modify `packages/shared/src/args.ts` — `canvasMotionSchema`, `motion` em `settingsSchema.canvas`, `emptySettings`.
- Modify `packages/shared/test/args.test.ts`, `packages/core/test/settings.test.ts` — expectativas com `motion`.
- Modify `packages/app/src/renderer/src/components/SettingsDialog.tsx` + `packages/app/test/settings-dialog.test.tsx` — seletor de movimento; prop `onCanvasChange` substitui `onSnapToGridChange`.
- Modify `packages/app/src/renderer/src/App.tsx` — estado `canvasSettings`.
- Modify `packages/app/src/renderer/src/canvas/Canvas.tsx` — prop `motion`, `data-motion`, hook de atividade.
- Create `packages/app/src/renderer/src/canvas/edge-activity.ts` + `packages/app/test/edge-activity.test.ts` — função pura `edgeActivity`, `edgeId`.
- Create `packages/app/src/renderer/src/canvas/use-edge-activity.ts` + `packages/app/test/use-edge-activity.test.tsx` — hook com atraso.
- Modify `packages/app/src/renderer/src/canvas/edge-routing.ts` + `packages/app/test/edge-routing.test.ts` — `edgeClassName`, `data.activity`.
- Modify `packages/app/src/renderer/src/canvas/RemovableEdge.tsx` + `packages/app/test/removable-edge.test.tsx` — pílula.
- Modify `packages/app/src/renderer/src/terminal/TerminalNode.tsx` — `frame-<estado>` e badge.
- Modify `packages/app/src/renderer/src/styles.css` — regras de aresta e de moldura.
- Create `packages/app/e2e/canvas-telemetry.spec.ts` — fluxo real no Electron.

Comandos de teste (na raiz do repositório):
- Unitários: `npx vitest run <caminho>`
- Tipos: `npm run typecheck`
- E2E: `npm run e2e -- canvas-telemetry` (roda `build:cli`, `build:host`, `electron-vite build` e o Playwright)

---

### Task 1: Configuração `canvas.motion` de ponta a ponta

**Files:**
- Modify: `packages/shared/src/args.ts:57-66`
- Modify: `packages/shared/test/args.test.ts:45-60`
- Modify: `packages/core/test/settings.test.ts`
- Modify: `packages/app/src/renderer/src/components/SettingsDialog.tsx`
- Modify: `packages/app/test/settings-dialog.test.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx:1,38,47,174,194`
- Modify: `packages/app/src/renderer/src/canvas/Canvas.tsx:112,210`

**Interfaces:**
- Produces: `canvasMotionSchema` e `type CanvasMotion = 'contained' | 'minimal'` em `@orquestra/shared/args`; `Settings['canvas']` = `{ snapToGrid: boolean; motion: CanvasMotion }`; prop `Canvas({ motion?: CanvasMotion })`; `.react-flow` com atributo `data-motion`.

- [ ] **Step 1: Atualizar os testes do schema para esperar `motion`**

Em `packages/shared/test/args.test.ts`, troque os dois blocos finais por:

```ts
describe('emptySettings', () => {
  it('padrões começam vazios', () => {
    expect(emptySettings()).toEqual({ defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
  });
});

describe('settingsSchema', () => {
  it('configura o grid magnético e o movimento contido por padrão em configurações antigas', async () => {
    const { settingsSchema } = await import('../src/args.js');
    expect(settingsSchema.parse({ defaultArgs: { claude: [], agy: [] } })).toEqual({
      defaultArgs: { claude: [], agy: [], codex: [] },
      canvas: { snapToGrid: true, motion: 'contained' },
    });
  });

  it('completa o movimento em um canvas salvo antes do campo existir', async () => {
    const { settingsSchema } = await import('../src/args.js');
    expect(settingsSchema.parse({ defaultArgs: { claude: [], agy: [] }, canvas: { snapToGrid: false } }).canvas).toEqual({ snapToGrid: false, motion: 'contained' });
  });

  it('recusa um movimento desconhecido', async () => {
    const { settingsSchema } = await import('../src/args.js');
    expect(() => settingsSchema.parse({ defaultArgs: { claude: [], agy: [] }, canvas: { snapToGrid: true, motion: 'turbo' } })).toThrow();
  });
});
```

Em `packages/core/test/settings.test.ts`, troque toda ocorrência de `canvas: { snapToGrid: true }` por `canvas: { snapToGrid: true, motion: 'contained' }`, e a linha do objeto `settings` do primeiro teste por:

```ts
    const settings = { defaultArgs: { claude: ['--dangerously-skip-permissions'], agy: [], codex: ['--no-daemon'] }, canvas: { snapToGrid: false, motion: 'minimal' as const } };
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/shared/test/args.test.ts packages/core/test/settings.test.ts`
Expected: FAIL — os objetos não têm `motion`.

- [ ] **Step 3: Implementar no schema**

Em `packages/shared/src/args.ts`, troque as linhas 57-66 por:

```ts
export const canvasMotionSchema = z.enum(['contained', 'minimal']);
export type CanvasMotion = z.infer<typeof canvasMotionSchema>;

export const settingsSchema = z.object({
  defaultArgs: z.object({ claude: z.array(z.string()), agy: z.array(z.string()), codex: z.array(z.string()).default([]) }),
  canvas: z.object({ snapToGrid: z.boolean().default(true), motion: canvasMotionSchema.default('contained') }).default({ snapToGrid: true, motion: 'contained' }),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

export function emptySettings(): Settings {
  return { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run packages/shared/test/args.test.ts packages/core/test/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Teste do diálogo**

Em `packages/app/test/settings-dialog.test.tsx`, na expectativa da linha 30 troque `canvas: { snapToGrid: false }` por `canvas: { snapToGrid: false, motion: 'contained' }`, e adicione dentro do `describe`:

```tsx
  it('salva o movimento escolhido e avisa o canvas', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        return method === 'settings.get' ? { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true } } : params;
      }) as CommandApi['command'],
    };
    const onCanvasChange = vi.fn();
    render(<SettingsDialog api={api} onClose={() => {}} onCanvasChange={onCanvasChange} />);
    const select = (await screen.findByTestId('settings-motion')) as HTMLSelectElement;
    expect(select.value).toBe('contained');
    fireEvent.change(select, { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    await waitFor(() => expect(onCanvasChange).toHaveBeenCalledWith({ snapToGrid: true, motion: 'minimal' }));
    expect(calls.at(-1)).toEqual(['settings.update', { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'minimal' } }]);
  });
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx vitest run packages/app/test/settings-dialog.test.tsx`
Expected: FAIL — `settings-motion` não existe.

- [ ] **Step 7: Implementar o diálogo**

Em `SettingsDialog.tsx`:

Import (linha 1):
```ts
import { canvasMotionSchema, formatArgs, parseArgs, reservedArgError, type CanvasMotion, type Settings } from '@orquestra/shared/args';
```

Assinatura e estado:
```tsx
export function SettingsDialog({ api, onClose, onCanvasChange }: { api: CommandApi; onClose(): void; onCanvasChange?(canvas: Settings['canvas']): void }) {
  const [texts, setTexts] = useState<Record<(typeof AGENTS)[number], string> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [motion, setMotion] = useState<CanvasMotion>('contained');
  const [error, setError] = useState<string | null>(null);
```

No `then` do carregamento, troque `canvas: loaded.canvas ?? { snapToGrid: true },` por:
```ts
          canvas: { snapToGrid: loaded.canvas?.snapToGrid ?? true, motion: loaded.canvas?.motion ?? 'contained' },
```
e depois de `setSnapToGrid(normalized.canvas.snapToGrid);` adicione `setMotion(normalized.canvas.motion);`.

No `catch`, troque `canvas: { snapToGrid: true }` por `canvas: { snapToGrid: true, motion: 'contained' }`.

No `submit`:
```ts
      const updated: Settings = { ...settings!, defaultArgs, canvas: { ...settings!.canvas, snapToGrid, motion } };
      await api.command('settings.update', updated);
      onCanvasChange?.(updated.canvas);
      onClose();
```

Depois do `<label className="check">` do grid magnético:
```tsx
        <label>
          Animações do canvas
          <select data-testid="settings-motion" value={motion} onChange={(event) => setMotion(canvasMotionSchema.parse(event.target.value))}>
            <option value="contained">Contido</option>
            <option value="minimal">Mínimo</option>
          </select>
        </label>
```

- [ ] **Step 8: Ligar App e Canvas**

Em `App.tsx`:
- Linha 1: `import { emptySettings, type Settings } from '@orquestra/shared/args';`
- Linha 38: `const [canvasSettings, setCanvasSettings] = useState<Settings['canvas']>(() => emptySettings().canvas);`
- Linha 47: `void globalApi.command('settings.get', {}).then((settings) => setCanvasSettings({ ...emptySettings().canvas, ...settings.canvas })).catch(() => {});`
- Linha 174: `<Canvas snapToGrid={canvasSettings.snapToGrid} motion={canvasSettings.motion} onRemoveRequest=...` (resto igual).
- Linha 194: `<SettingsDialog api={api} onClose={() => setSettingsOpen(false)} onCanvasChange={setCanvasSettings} />`

Em `Canvas.tsx`:
- Import: `import type { CanvasMotion } from '@orquestra/shared/args';`
- Linha 112: `export function Canvas({ snapToGrid = true, motion = 'contained', onRemoveRequest, onNewGroup }: { snapToGrid?: boolean; motion?: CanvasMotion; onRemoveRequest(name: string): void; onNewGroup?(selection: boolean, position?: Position): void }) {`
- No `<ReactFlow`, logo após `edgeTypes={edgeTypes}`: `data-motion={motion}`

- [ ] **Step 9: Verificar**

Run: `npx vitest run packages/shared/test/args.test.ts packages/core/test/settings.test.ts packages/app/test/settings-dialog.test.tsx && npm run typecheck`
Expected: PASS, sem erros de tipo.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/args.ts packages/shared/test/args.test.ts packages/core/test/settings.test.ts packages/app/src/renderer/src/components/SettingsDialog.tsx packages/app/test/settings-dialog.test.tsx packages/app/src/renderer/src/App.tsx packages/app/src/renderer/src/canvas/Canvas.tsx
git commit -m "Adiciona a escolha de animações do canvas nas configurações"
```

---

### Task 2: Função pura `edgeActivity`

**Files:**
- Create: `packages/app/src/renderer/src/canvas/edge-activity.ts`
- Test: `packages/app/test/edge-activity.test.ts`

**Interfaces:**
- Consumes: `EdgeView` (`{ a: string; b: string }`) de `../store`; `QueueEntry` de `@orquestra/shared/host-protocol`.
- Produces:
  - `type EdgeActivity = { flow: 'a→b' | 'b→a' | 'both'; kind: 'prompt' | 'delivery'; running: boolean }`
  - `edgeId(edge: EdgeView): string` → `${a}--${b}`
  - `edgeActivity(edges: EdgeView[], queues: Record<string, QueueEntry[]>): Map<string, EdgeActivity>`

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { edgeActivity, edgeId } from '../src/renderer/src/canvas/edge-activity';

const entry = (from: string, overrides: Partial<QueueEntry> = {}): QueueEntry => ({ askId: `${from}-${Math.random()}`, from, preview: 'p', status: 'queued', kind: 'prompt', ...overrides });
const edges = [{ a: 'A', b: 'B' }];

describe('edgeActivity', () => {
  it('monta o id igual ao do canvas', () => {
    expect(edgeId({ a: 'A', b: 'B' })).toBe('A--B');
  });

  it('sem fila, nenhuma aresta acende', () => {
    expect(edgeActivity(edges, {}).size).toBe(0);
    expect(edgeActivity(edges, { B: [] }).size).toBe(0);
  });

  it('pedido de A na fila de B é fluxo a→b', () => {
    expect(edgeActivity(edges, { B: [entry('A')] }).get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: false });
  });

  it('pedido de B na fila de A é fluxo b→a', () => {
    expect(edgeActivity(edges, { A: [entry('B', { kind: 'delivery', status: 'running' })] }).get('A--B')).toEqual({ flow: 'b→a', kind: 'delivery', running: true });
  });

  it('pedidos nos dois sentidos viram both', () => {
    expect(edgeActivity(edges, { A: [entry('B')], B: [entry('A')] }).get('A--B')?.flow).toBe('both');
  });

  it('o pedido em curso define o tipo, mesmo atrás de um na fila', () => {
    const activity = edgeActivity(edges, { B: [entry('A', { kind: 'prompt' }), entry('A', { kind: 'delivery', status: 'running' })] }).get('A--B');
    expect(activity).toEqual({ flow: 'a→b', kind: 'delivery', running: true });
  });

  it('sem pedido em curso, vale o primeiro da fila', () => {
    const activity = edgeActivity(edges, { B: [entry('A', { kind: 'delivery' }), entry('A', { kind: 'prompt' })] }).get('A--B');
    expect(activity).toEqual({ flow: 'a→b', kind: 'delivery', running: false });
  });

  it('fila de um terceiro terminal não acende a aresta', () => {
    expect(edgeActivity(edges, { B: [entry('C')], C: [entry('A')] }).size).toBe(0);
  });

  it('pedido entre terminais sem aresta não aparece', () => {
    expect(edgeActivity([], { B: [entry('A')] }).size).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/app/test/edge-activity.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import type { EdgeView } from '../store';

/** O que passa por uma conexão agora: sentido, tipo do pedido e se ele já está em curso. */
export type EdgeActivity = { flow: 'a→b' | 'b→a' | 'both'; kind: QueueEntry['kind']; running: boolean };

export function edgeId(edge: EdgeView): string {
  return `${edge.a}--${edge.b}`;
}

/** A conexão não tem direção; o sentido sai de quem pediu (`from`) e de em que fila o pedido está. */
export function edgeActivity(edges: EdgeView[], queues: Record<string, QueueEntry[]>): Map<string, EdgeActivity> {
  const result = new Map<string, EdgeActivity>();
  for (const edge of edges) {
    const forward = (queues[edge.b] ?? []).filter((entry) => entry.from === edge.a);
    const backward = (queues[edge.a] ?? []).filter((entry) => entry.from === edge.b);
    const entries = [...forward, ...backward];
    const lead = entries.find((entry) => entry.status === 'running') ?? entries[0];
    if (!lead) continue;
    const flow = forward.length && backward.length ? 'both' : forward.length ? 'a→b' : 'b→a';
    result.set(edgeId(edge), { flow, kind: lead.kind, running: lead.status === 'running' });
  }
  return result;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run packages/app/test/edge-activity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/src/canvas/edge-activity.ts packages/app/test/edge-activity.test.ts
git commit -m "Deriva da fila o sentido e o tipo do pedido em cada conexão"
```

---

### Task 3: Hook `useEdgeActivity` com atraso de 3 s

**Files:**
- Create: `packages/app/src/renderer/src/canvas/use-edge-activity.ts`
- Test: `packages/app/test/use-edge-activity.test.tsx`

**Interfaces:**
- Consumes: `edgeActivity`, `EdgeActivity` (Task 2).
- Produces: `LINGER_MS = 3000`; `useEdgeActivity(edges: EdgeView[], queues: Record<string, QueueEntry[]>, scope: string | undefined, lingerMs?: number): Map<string, EdgeActivity>`. `scope` é o id do workspace: quando muda, o que estava no atraso é descartado.

- [ ] **Step 1: Escrever os testes**

```tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINGER_MS, useEdgeActivity } from '../src/renderer/src/canvas/use-edge-activity';
import type { EdgeView } from '../src/renderer/src/store';

const edges: EdgeView[] = [{ a: 'A', b: 'B' }];
const running: Record<string, QueueEntry[]> = { B: [{ askId: '1', from: 'A', preview: 'p', status: 'running', kind: 'prompt' }] };
type Props = { queues: Record<string, QueueEntry[]>; scope: string };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (initial: Props) => renderHook((props: Props) => useEdgeActivity(edges, props.queues, props.scope), { initialProps: initial });

describe('useEdgeActivity', () => {
  it('mantém a atividade sem "em curso" por 3 s depois que a fila esvazia', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: true });
    rerender({ queues: {}, scope: 'w1' });
    expect(result.current.get('A--B')).toEqual({ flow: 'a→b', kind: 'prompt', running: false });
    act(() => vi.advanceTimersByTime(LINGER_MS - 1));
    expect(result.current.has('A--B')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.has('A--B')).toBe(false);
  });

  it('pedido novo durante o atraso cancela o apagar', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w1' });
    act(() => vi.advanceTimersByTime(1000));
    rerender({ queues: running, scope: 'w1' });
    act(() => vi.advanceTimersByTime(LINGER_MS * 2));
    expect(result.current.get('A--B')?.running).toBe(true);
  });

  it('trocar de workspace descarta o que estava no atraso', () => {
    const { result, rerender } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w2' });
    expect(result.current.has('A--B')).toBe(false);
    act(() => vi.advanceTimersByTime(LINGER_MS));
    expect(result.current.size).toBe(0);
  });

  it('desmontar limpa os timers', () => {
    const { rerender, unmount } = setup({ queues: running, scope: 'w1' });
    rerender({ queues: {}, scope: 'w1' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/app/test/use-edge-activity.test.tsx`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeView } from '../store';
import { edgeActivity, type EdgeActivity } from './edge-activity';

/** Tempo que a conexão fica acesa depois da entrega, para dar tempo de ver quem falou com quem. */
export const LINGER_MS = 3000;

/** Atividade das conexões com atraso ao apagar; `scope` (o workspace) zera o atraso ao trocar. */
export function useEdgeActivity(edges: EdgeView[], queues: Record<string, QueueEntry[]>, scope: string | undefined, lingerMs = LINGER_MS): Map<string, EdgeActivity> {
  const live = useMemo(() => edgeActivity(edges, queues), [edges, queues]);
  const previous = useRef({ scope, live });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [lingering, setLingering] = useState<ReadonlyMap<string, EdgeActivity>>(() => new Map());

  useEffect(() => {
    const before = previous.current;
    previous.current = { scope, live };
    if (before.scope !== scope) {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      setLingering(new Map());
      return;
    }
    for (const id of live.keys()) {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
    }
    const ended = [...before.live].filter(([id]) => !live.has(id));
    if (!ended.length) return;
    for (const [id] of ended) {
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        setLingering((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }, lingerMs));
    }
    setLingering((current) => {
      const next = new Map(current);
      for (const [id, activity] of ended) next.set(id, { ...activity, running: false });
      return next;
    });
  }, [live, scope, lingerMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending.values()) clearTimeout(timer); };
  }, []);

  // Na troca de workspace o atraso antigo ainda está no estado até o efeito rodar: só vale o do mesmo scope.
  const visibleLingering = previous.current.scope === scope ? lingering : new Map<string, EdgeActivity>();
  return useMemo(() => new Map([...visibleLingering, ...live]), [visibleLingering, live]);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run packages/app/test/use-edge-activity.test.tsx`
Expected: PASS. Se o teste "trocar de workspace" falhar na primeira asserção, confira que `visibleLingering` usa `previous.current.scope`, que só é atualizado dentro do efeito.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/src/canvas/use-edge-activity.ts packages/app/test/use-edge-activity.test.tsx
git commit -m "Mantém a conexão acesa por 3 s depois da entrega e zera ao trocar de workspace"
```

---

### Task 4: Arestas vivas — classes, pílula e CSS

**Files:**
- Modify: `packages/app/src/renderer/src/canvas/edge-routing.ts`
- Modify: `packages/app/test/edge-routing.test.ts`
- Modify: `packages/app/src/renderer/src/canvas/RemovableEdge.tsx`
- Modify: `packages/app/test/removable-edge.test.tsx`
- Modify: `packages/app/src/renderer/src/canvas/Canvas.tsx:119,168`
- Modify: `packages/app/src/renderer/src/styles.css:164`

**Interfaces:**
- Consumes: `EdgeActivity`, `edgeId` (Task 2); `useEdgeActivity` (Task 3); `data-motion` (Task 1).
- Produces: `edgeClassName(activity: EdgeActivity | undefined): string`; `buildClosestEdges(edges, nodes, activity?: Map<string, EdgeActivity>)`; arestas com `data: { activity }` quando ativas; pílula `data-testid="edge-pill-<id>"`.

- [ ] **Step 1: Testes de roteamento**

Em `packages/app/test/edge-routing.test.ts`, mude o import para `import { nearestHandles, buildClosestEdges, edgeClassName } from '../src/renderer/src/canvas/edge-routing';` e adicione no fim:

```ts
describe('atividade nas conexões', () => {
  const connection = [{ a: 'A', b: 'B' }];
  const nodes = [node('A', 0), node('B', 720)];

  it('aresta sem atividade fica só com a classe base e sem dados', () => {
    expect(buildClosestEdges(connection, nodes)[0]).toMatchObject({ className: 'orq-edge', data: undefined });
  });

  it('marca ativa, em curso e o sentido inverso', () => {
    const activity = new Map([['A--B', { flow: 'b→a' as const, kind: 'delivery' as const, running: true }]]);
    const edge = buildClosestEdges(connection, nodes, activity)[0]!;
    expect(edge.className).toBe('orq-edge orq-edge--active orq-edge--running orq-edge--reverse');
    expect(edge.data).toEqual({ activity: activity.get('A--B') });
  });

  it('nos dois sentidos não marca inverso', () => {
    expect(edgeClassName({ flow: 'both', kind: 'prompt', running: true })).toBe('orq-edge orq-edge--active orq-edge--running orq-edge--both');
    expect(edgeClassName({ flow: 'a→b', kind: 'prompt', running: false })).toBe('orq-edge orq-edge--active');
  });

  it('atividade de uma aresta que já não existe é ignorada', () => {
    const activity = new Map([['A--C', { flow: 'a→b' as const, kind: 'prompt' as const, running: true }]]);
    expect(buildClosestEdges(connection, nodes, activity).map((edge) => edge.className)).toEqual(['orq-edge']);
  });
});
```

- [ ] **Step 2: Testes da pílula**

Em `packages/app/test/removable-edge.test.tsx`, adicione dentro do `describe`:

```tsx
  it('mostra a pílula do tipo de pedido e a esconde em hover para dar lugar ao ×', () => {
    const { container } = renderEdge(props({ data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    expect(screen.getByTestId('edge-pill-A--B').textContent).toBe('⚡ delegando');
    fireEvent.mouseEnter(container.querySelector('g.orq-edge-hit')!);
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });

  it('resposta voltando usa a pílula de retorno; sem atividade não há pílula', () => {
    renderEdge(props({ data: { activity: { flow: 'b→a', kind: 'delivery', running: false } } }));
    expect(screen.getByTestId('edge-pill-A--B').textContent).toBe('📩 retornando');
    cleanup();
    renderEdge(props());
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });

  it('aresta selecionada esconde a pílula', () => {
    renderEdge(props({ selected: true, data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run packages/app/test/edge-routing.test.ts packages/app/test/removable-edge.test.tsx`
Expected: FAIL — `edgeClassName` não existe e não há pílula.

- [ ] **Step 4: Implementar o roteamento**

Em `edge-routing.ts`, adicione o import `import { edgeId, type EdgeActivity } from './edge-activity';` e substitua `buildClosestEdges` por:

```ts
/** Classes que o CSS usa para acender, animar e inverter o sentido da conexão. */
export function edgeClassName(activity: EdgeActivity | undefined): string {
  if (!activity) return 'orq-edge';
  const classes = ['orq-edge', 'orq-edge--active'];
  if (activity.running) classes.push('orq-edge--running');
  if (activity.flow === 'b→a') classes.push('orq-edge--reverse');
  if (activity.flow === 'both') classes.push('orq-edge--both');
  return classes.join(' ');
}

export function buildClosestEdges(edges: EdgeView[], nodes: CanvasFlowNode[], activity: ReadonlyMap<string, EdgeActivity> = new Map()): Edge[] {
  const rects = new Map<string, Rect>();
  for (const node of nodes) {
    if (node.type === 'groupFrame') continue;
    const width = node.measured?.width ?? node.width ?? Number(node.style?.width);
    const height = node.measured?.height ?? node.height ?? Number(node.style?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) rects.set(node.id, { ...node.position, width, height });
  }
  return edges.flatMap((edge) => {
    const a = rects.get(edge.a), b = rects.get(edge.b);
    if (!a || !b) return [];
    const id = edgeId(edge);
    const current = activity.get(id);
    const handles = nearestHandles(a, b, nodes.find((node) => node.id === edge.a)?.type === 'portal', nodes.find((node) => node.id === edge.b)?.type === 'portal');
    return [{ id, source: edge.a, target: edge.b, ...handles, type: EDGE_TYPE, className: edgeClassName(current), data: current ? { activity: current } : undefined }];
  });
}
```

- [ ] **Step 5: Implementar a pílula**

Em `RemovableEdge.tsx`, adicione o import `import type { EdgeActivity } from './edge-activity';`, a constante antes do componente:

```tsx
const PILL_LABEL: Record<EdgeActivity['kind'], string> = { prompt: '⚡ delegando', delivery: '📩 retornando' };
```

e no corpo do componente:

```tsx
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const activity = data?.activity as EdgeActivity | undefined;
  const controlsVisible = hovered || Boolean(selected);
  const center = `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`;
```

Dentro do `<EdgeLabelRenderer>`, use `style={{ transform: center }}` e `className={`edge-remove nodrag nopan${controlsVisible ? ' visible' : ''}`}` no botão, e adicione depois dele:

```tsx
        {activity && !controlsVisible ? <span className="edge-pill" data-testid={`edge-pill-${id}`} style={{ transform: center }}>{PILL_LABEL[activity.kind]}</span> : null}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run packages/app/test/edge-routing.test.ts packages/app/test/removable-edge.test.tsx`
Expected: PASS

- [ ] **Step 7: Ligar no Canvas**

Em `Canvas.tsx`, adicione o import `import { useEdgeActivity } from './use-edge-activity';`, depois da linha 119 (`const edgesView = ...`):

```ts
  const queues = useApp((state) => state.queues);
  const activity = useEdgeActivity(edgesView, queues, workspaceId);
```

e troque a linha 168 por:

```ts
  const baseEdges = useMemo(() => [...buildClosestEdges(edgesView, nodes, activity), ...dataEdges(flow.graph, terminals)], [edgesView, nodes, activity, flow.graph, terminals]);
```

- [ ] **Step 8: CSS das arestas**

Em `styles.css`, insira logo depois da linha 164 (`.orq-edge path, .react-flow__edge-path { ... }`) e antes da regra `.selected`, para a seleção continuar vencendo:

```css
.react-flow__edge.orq-edge path.react-flow__edge-path { opacity: 0.25; transition: opacity 0.2s; }
.react-flow__edge.orq-edge:hover path.react-flow__edge-path, .react-flow__edge.orq-edge--active path.react-flow__edge-path { opacity: 1; }
.react-flow__edge.orq-edge--running path.react-flow__edge-path { stroke-width: 3; }
@media (prefers-reduced-motion: no-preference) {
  [data-motion="contained"] .react-flow__edge.orq-edge--running:not(.orq-edge--both) path.react-flow__edge-path { stroke-width: 2.5; stroke-dasharray: 8 6; animation: orq-edge-flow 0.6s linear infinite; }
  [data-motion="contained"] .react-flow__edge.orq-edge--running.orq-edge--reverse path.react-flow__edge-path { animation-direction: reverse; }
}
@keyframes orq-edge-flow { from { stroke-dashoffset: 14; } to { stroke-dashoffset: 0; } }
.edge-pill { position: absolute; pointer-events: none; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--acc); background: var(--panel); color: var(--acc); font-size: 11px; white-space: nowrap; }
```

- [ ] **Step 9: Verificar**

Run: `npx vitest run packages/app/test && npm run typecheck`
Expected: PASS, sem erros de tipo.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/renderer/src/canvas/edge-routing.ts packages/app/test/edge-routing.test.ts packages/app/src/renderer/src/canvas/RemovableEdge.tsx packages/app/test/removable-edge.test.tsx packages/app/src/renderer/src/canvas/Canvas.tsx packages/app/src/renderer/src/styles.css
git commit -m "Acende e anima a conexão no sentido do pedido, com a pílula de delegação ou retorno"
```

---

### Task 5: Moldura do card por estado + e2e

**Files:**
- Modify: `packages/app/src/renderer/src/terminal/TerminalNode.tsx:208,233`
- Modify: `packages/app/src/renderer/src/styles.css:128-129`
- Create: `packages/app/e2e/canvas-telemetry.spec.ts`

**Interfaces:**
- Consumes: `data-motion` (Task 1), classes de aresta e `edge-pill-<id>` (Task 4).
- Produces: `.term-node.frame-<starting|idle|busy|waiting|exited>` (a classe `frame-exited` não recebe tratamento visual); badge `data-testid="terminal-waiting-<nome>"`.

| Cards | Tratamento visual |
|---|---|
| `starting` | Estilo base, sem tratamento específico. |
| `exited` | Igual a `starting`; mantém `frame-exited` no DOM, sem estilo específico. |
| `idle` | Borda discreta e cabeçalho esmaecido. |
| `busy` | Borda ocupada, barra e spinner no modo contido. |
| `waiting` | Borda âmbar, glow e badge. |

O `TerminalNode` depende de ReactFlow, xterm e da API do host; não há teste de render isolado dele no repositório. A cobertura desta task é o e2e, que também cobre as Tasks 1-4 no app real.

- [ ] **Step 1: Escrever o e2e**

```ts
import { expect, test } from '@playwright/test';
import type { HostEvent } from '@orquestra/shared/host-protocol';
import { createShell, launchApp } from './launch';

test('a conexão acende no sentido do pedido e a moldura mostra o estado do terminal', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await createShell(page, 'T');
    await page.getByTestId('palette-connect').click();
    await page.getByTestId('terminal-header-S').click();
    await page.getByTestId('terminal-header-T').click();
    const edge = page.locator('.react-flow__edge.orq-edge');
    await expect(edge).toHaveCount(1);
    await expect(edge).not.toHaveClass(/orq-edge--active/);
    await expect(page.locator('.react-flow')).toHaveAttribute('data-motion', 'contained');

    const workspaceId = await page.evaluate(async () => {
      const result = await window.orquestra.invoke('workspace.list', {});
      if (!result.ok) throw new Error('Não foi possível consultar o workspace de teste.');
      return (result.result as { selectedId: string }).selectedId;
    });
    const send = (event: HostEvent & { workspaceId: string }) => app.evaluate(({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('orq:event', message);
    }, event);

    await send({ type: 'terminal.queue', name: 'T', entries: [{ askId: 'x', from: 'S', preview: 'p', status: 'running', kind: 'prompt' }], workspaceId });
    await expect(edge).toHaveClass(/orq-edge--active/);
    await expect(edge).toHaveClass(/orq-edge--running/);
    await expect(page.getByTestId('edge-pill-S--T')).toHaveText('⚡ delegando');

    await send({ type: 'terminal.queue', name: 'T', entries: [], workspaceId });
    await expect(edge).not.toHaveClass(/orq-edge--running/);
    await expect(page.getByTestId('edge-pill-S--T')).toBeVisible();
    await expect(page.getByTestId('edge-pill-S--T')).toHaveCount(0, { timeout: 6000 });
    await expect(edge).not.toHaveClass(/orq-edge--active/);

    const card = page.locator('[data-id="S"] .term-node');
    await send({ type: 'terminal.state', name: 'S', state: 'waiting', queued: 0, sequence: 1_000_000, workspaceId });
    await expect(card).toHaveClass(/frame-waiting/);
    await expect(page.getByTestId('terminal-waiting-S')).toHaveText('👋 aguardando você');
    await send({ type: 'terminal.state', name: 'S', state: 'busy', queued: 0, sequence: 1_000_001, workspaceId });
    await expect(card).toHaveClass(/frame-busy/);
    await expect(page.getByTestId('terminal-waiting-S')).toHaveCount(0);
  } finally { await app.close(); }
});
```

Se o tipo de `send` não aceitar `workspaceId` junto de `HostEvent` (o `queue-state.spec.ts` usa `Extract<HostEvent, …>` com o campo extra), siga o mesmo padrão daquele arquivo.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run e2e -- canvas-telemetry`
Expected: FAIL em `frame-waiting` (as asserções de aresta já passam por causa da Task 4).

- [ ] **Step 3: Implementar no TerminalNode**

Linha 208:
```tsx
    <div className={`term-node frame-${view.state} ${selected ? 'is-selected' : ''} ${view.locked ? 'is-locked nopan' : ''}`}>
```

Dentro de `<div className="term-display">`, como primeiro filho:
```tsx
        {view.state === 'waiting' ? <span className="waiting-badge" data-testid={`terminal-waiting-${data.name}`}>👋 aguardando você</span> : null}
```

- [ ] **Step 4: CSS das molduras**

Em `styles.css`, troque a linha 128 por:

```css
.term-node { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--node); border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.term-node.frame-idle { border-color: #2a2e37; }
.term-node.frame-idle .term-hd { opacity: 0.75; }
.term-node.frame-busy { border-color: var(--busy); }
.term-node.frame-waiting { border-color: var(--wait); box-shadow: 0 0 10px 1px var(--wait); }
.waiting-badge { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); z-index: 11; pointer-events: none; padding: 2px 10px; border-radius: 10px; background: var(--wait); color: #111; font-size: 11px; font-weight: 600; white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  [data-motion="contained"] .term-node.frame-busy::before { content: ''; position: absolute; top: 0; left: 0; z-index: 12; width: 35%; height: 2px; background: var(--busy); animation: orq-busy-bar 1.4s ease-in-out infinite; }
  [data-motion="contained"] .term-node.frame-busy .term-state .dot { box-sizing: border-box; background: transparent; border: 2px solid var(--busy); border-top-color: transparent; animation: orq-spin 0.8s linear infinite; }
  [data-motion="contained"] .term-node.frame-waiting { animation: orq-wait-pulse 1.5s ease-in-out infinite; }
}
@keyframes orq-busy-bar { from { left: -35%; } to { left: 100%; } }
@keyframes orq-spin { to { transform: rotate(360deg); } }
@keyframes orq-wait-pulse { 0%, 100% { box-shadow: 0 0 4px 0 var(--wait); } 50% { box-shadow: 0 0 16px 3px var(--wait); } }
```

A regra `.term-node.is-selected` (linha 129 original) fica depois destas e continua vencendo para a borda.

- [ ] **Step 5: Rodar e ver passar**

Run: `npm run e2e -- canvas-telemetry`
Expected: PASS

- [ ] **Step 6: Suíte completa**

Run: `npm test && npm run typecheck && npm run e2e -- queue-state edge-routing`
Expected: tudo PASS; os e2e existentes de fila e arestas continuam verdes.

- [ ] **Step 7: Conferência visual**

Run: `npm run dev`. Conecte dois agentes, faça um pedir algo ao outro e confira: tracejado correndo no sentido do destino, pílula no meio, sumindo cerca de 3 s depois da entrega; card ocupado com barra e spinner; "aguardando você" pulsando. Troque para "Mínimo" em Configurações e confira que nada se move. Em Windows, ative "Mostrar animações no Windows: desligado" e confira que o modo contido fica igual ao mínimo.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/renderer/src/terminal/TerminalNode.tsx packages/app/src/renderer/src/styles.css packages/app/e2e/canvas-telemetry.spec.ts
git commit -m "Mostra o estado do agente na moldura do card e cobre a telemetria do canvas em e2e"
```
