import { z } from 'zod';
import { queueEntrySchema, terminalInfoSchema, type ProjectSnapshot } from './host-protocol.js';

/**
 * O que o celular recebe de um workspace: só os agentes e as filas. Notas, fluxo, grupos, layout do canvas
 * e demais conteúdos do projeto nunca atravessam o gateway.
 */
export const remoteSnapshotSchema = z.object({
  workspaceId: z.string(),
  eventSequence: z.number().int().nonnegative().optional(),
  name: z.string(),
  terminals: z.array(terminalInfoSchema),
  queues: z.record(z.array(queueEntrySchema)).optional(),
});
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>;

export function toRemoteSnapshot(snapshot: Pick<ProjectSnapshot, 'workspaceId' | 'eventSequence' | 'name' | 'terminals' | 'queues'>): RemoteSnapshot {
  return remoteSnapshotSchema.parse({
    workspaceId: snapshot.workspaceId ?? '',
    eventSequence: snapshot.eventSequence,
    name: snapshot.name,
    terminals: snapshot.terminals,
    queues: snapshot.queues,
  });
}

/** Resultados que o celular recebe de forma diferente do desktop. */
export const remoteResultOverrides = { 'workspace.activate': remoteSnapshotSchema } as const;
