import type { Edge } from '@xyflow/react';
import type { CommandApi } from '../api';
import { appStore } from '../store';

export type DisconnectableEdge = Pick<Edge, 'source' | 'target' | 'data'>;

/** Único caminho de remoção de aresta: usado por Delete, menu de contexto e botão ×. */
export async function disconnectEdge(edge: DisconnectableEdge, api: CommandApi): Promise<void> {
  const state = appStore.getState();
  try {
    if (edge.data?.kind === 'flow') {
      state.applyFlow(await api.command('flow.disconnect', { id: String(edge.data.id) }));
      return;
    }
    await api.command('edge.disconnect', { a: edge.source, b: edge.target });
    state.removeEdge({ a: edge.source, b: edge.target });
  } catch (error) {
    appStore.getState().notify('error', (error as Error).message);
  }
}
