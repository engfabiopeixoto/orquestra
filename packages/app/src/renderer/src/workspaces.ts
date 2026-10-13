import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export const workspaceStore = createStore<{ workspaces: WorkspaceInfo[]; selectedId: string | null; changing: boolean; focusRequest: { name: string; workspaceId?: string } | null }>(() => ({ workspaces: [], selectedId: null, changing: false, focusRequest: null }));
export const useWorkspaces = <T,>(selector: (state: ReturnType<typeof workspaceStore.getState>) => T) => useStore(workspaceStore, selector);
