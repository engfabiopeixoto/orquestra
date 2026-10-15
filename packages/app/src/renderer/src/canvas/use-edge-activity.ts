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
