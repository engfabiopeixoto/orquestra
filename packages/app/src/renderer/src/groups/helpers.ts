import type { GroupElement } from '@orquestra/shared/group-layout';
import type { GroupMember } from '@orquestra/shared/workspace';
import type { CommandApi } from '../api';
import { appStore, type AppState } from '../store';

export function canvasElements(state: AppState): GroupElement[] {
  return [
    ...Object.values(state.terminals).flatMap((terminal) => terminal.id ? [{ kind: 'terminal' as const, id: terminal.id, name: terminal.name, rect: { ...terminal.position, ...terminal.size }, locked: Boolean(terminal.locked) }] : []),
    ...Object.values(state.notes).flatMap((note) => note.id ? [{ kind: 'note' as const, id: note.id, name: note.name, rect: { ...note.position, ...note.size }, locked: false }] : []),
    ...state.flow.graph.nodes.filter((node) => node.kind !== 'agent').map((node) => ({ kind: 'flow' as const, id: node.id, name: `flow:${node.id}`, rect: { ...node.position, ...node.size }, locked: false })),
  ];
}
export function selectionMembers(state: AppState): GroupMember[] {
  return canvasElements(state).filter((element) => state.selectedNodes.includes(element.name)).map(({ kind, id }) => ({ kind, id }));
}
export async function recoverGroupLayout(api: CommandApi, error: unknown): Promise<void> {
  appStore.getState().notify('error', error instanceof Error ? error.message : 'Não foi possível atualizar o grupo.');
  try { appStore.getState().applyGroupLayout(await api.command('group.layout', {})); } catch { /* A workspace switch owns its own snapshot. */ }
}
