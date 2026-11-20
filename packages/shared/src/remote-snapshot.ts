import { z } from 'zod';
import { queueEntrySchema, terminalInfoSchema, workspaceInfoSchema, type ProjectSnapshot, type WorkspaceInfo } from './host-protocol.js';

/**
 * O que o celular recebe de um workspace: só os agentes e as filas. Notas, grupos, layout do canvas
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

/** No celular a lista de workspaces omite o caminho da pasta (`dir`) no computador. */
export const remoteWorkspaceInfoSchema = workspaceInfoSchema.omit({ dir: true });
export type RemoteWorkspaceInfo = z.infer<typeof remoteWorkspaceInfoSchema>;

export const remoteWorkspaceListSchema = z.object({
  workspaces: z.array(remoteWorkspaceInfoSchema).max(3),
  selectedId: z.string().nullable(),
});
export type RemoteWorkspaceList = z.infer<typeof remoteWorkspaceListSchema>;

export function toRemoteWorkspaceList(result: {
  workspaces: Array<Pick<WorkspaceInfo, 'id' | 'name' | 'status' | 'terminalCount' | 'busy' | 'waiting'>>;
  selectedId: string | null;
}): RemoteWorkspaceList {
  return remoteWorkspaceListSchema.parse({
    workspaces: result.workspaces.map(({ id, name, status, terminalCount, busy, waiting }) => ({
      id,
      name,
      status,
      terminalCount,
      busy,
      waiting,
    })),
    selectedId: result.selectedId,
  });
}

/** Resultados que o celular recebe de forma diferente do desktop. */
export const remoteResultOverrides = {
  'workspace.activate': remoteSnapshotSchema,
  'workspace.list': remoteWorkspaceListSchema,
} as const;
