import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export const workspaceStore = createStore<{ workspaces: WorkspaceInfo[]; selectedId: string | null; changing: boolean; focusRequest: { name: string; workspaceId?: string } | null }>(() => ({ workspaces: [], selectedId: null, changing: false, focusRequest: null }));
/** Texto da segunda linha do projeto na sidebar. */
export function workspaceSummary(workspace: WorkspaceInfo): string {
  if (workspace.status === 'paused') return 'pausado';
  const agents = workspace.terminalCount === 1 ? '1 agente' : `${workspace.terminalCount} agentes`;
  const busy = workspace.busy ? ` · ${workspace.busy === 1 ? '1 ativo' : `${workspace.busy} ativos`}` : '';
  const waiting = workspace.waiting ? ` · ${workspace.waiting} aguardando` : '';
  return `${agents}${busy}${waiting}`;
}

/** Classe do ponto de status: aguardando vence ativo, que vence o status do workspace. */
export function workspaceDot(workspace: WorkspaceInfo): string {
  return workspace.waiting ? 'waiting' : workspace.busy ? 'busy' : workspace.status;
}

export const useWorkspaces = <T,>(selector: (state: ReturnType<typeof workspaceStore.getState>) => T) => useStore(workspaceStore, selector);
