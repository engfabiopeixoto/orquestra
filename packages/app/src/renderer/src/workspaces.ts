import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export const workspaceStore = createStore<{ workspaces: WorkspaceInfo[]; selectedId: string | null; changing: boolean; focusRequest: { name: string; workspaceId?: string } | null }>(() => ({ workspaces: [], selectedId: null, changing: false, focusRequest: null }));
/** Texto da segunda linha do projeto na sidebar. */
export function workspaceSummary(workspace: WorkspaceInfo): string {
  if (workspace.status === 'paused') return 'pausado';
  return `${workspace.terminalCount} agentes${workspace.busy ? ` · ${workspace.busy} ativos` : ''}${workspace.waiting ? ` · ${workspace.waiting} aguardando` : ''}`;
}

/** Classe do ponto de status: aguardando vence ativo, que vence o status do workspace. */
export function workspaceDot(workspace: WorkspaceInfo): string {
  return workspace.waiting ? 'waiting' : workspace.busy ? 'busy' : workspace.status;
}

export const useWorkspaces = <T,>(selector: (state: ReturnType<typeof workspaceStore.getState>) => T) => useStore(workspaceStore, selector);
