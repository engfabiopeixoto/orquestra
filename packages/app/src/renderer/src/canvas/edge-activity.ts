import type { QueueEntry } from '@orquestra/shared/host-protocol';
import type { AnsweredAsk, EdgeView } from '../store';

/** O que passa por uma conexão agora: sentido, tipo do pedido e se ele já está em curso. */
export type EdgeActivity = { flow: 'a→b' | 'b→a' | 'both'; kind: QueueEntry['kind'] | 'reply'; running: boolean };

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

/** Resposta recente percorre a aresta do alvo até quem enviou o prompt. */
export function answeredEdgeActivity(edges: EdgeView[], answers: AnsweredAsk[], now: number, lingerMs: number): Map<string, EdgeActivity> {
  const result = new Map<string, EdgeActivity>();
  for (const edge of edges) {
    const latest = answers
      .filter((answer) => answer.at <= now && now - answer.at < lingerMs && (
        (answer.target === edge.a && answer.from === edge.b) || (answer.target === edge.b && answer.from === edge.a)
      ))
      .reduce<AnsweredAsk | undefined>((current, answer) => !current || answer.at >= current.at ? answer : current, undefined);
    if (!latest) continue;
    const flow = latest.target === edge.a ? 'a→b' : 'b→a';
    result.set(edgeId(edge), { flow, kind: 'reply', running: false });
  }
  return result;
}
