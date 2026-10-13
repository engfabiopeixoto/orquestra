import { createCommandApi, type CommandApi } from './api';
import { appStore } from './store';
import { setActiveWorkspace } from './workspace-context';
import { workspaceStore } from './workspaces';
import type { ProjectSnapshot } from '@orquestra/shared/host-protocol';
import { flushWorkspaceEvents, forgetWorkspaceEvents } from './events';

const defaultApi = createCommandApi((...args) => window.orquestra?.invoke(...args));
const selections = new Map<string, { focusedTerminal: string | null; selectedNodes: string[] }>();
function show(snapshot: ProjectSnapshot): void {
  const state = appStore.getState();
  if (state.project?.workspaceId) selections.set(state.project.workspaceId, { focusedTerminal: state.focusedTerminal, selectedNodes: state.selectedNodes });
  setActiveWorkspace(snapshot.workspaceId);
  if (snapshot.workspaceId) void window.orquestra?.portal?.setActiveWorkspace(snapshot.workspaceId);
  const saved = snapshot.workspaceId ? selections.get(snapshot.workspaceId) : undefined;
  state.loadProject(snapshot, saved);
  flushWorkspaceEvents(appStore.getState(), snapshot.workspaceId, snapshot.eventSequence);
}

export function startupProject(recent: Array<{ dir: string }>, testProject: string | null): string | null {
  return testProject ?? recent[0]?.dir ?? null;
}

export async function openProject(dir: string, api: CommandApi = defaultApi): Promise<void> {
  if (workspaceStore.getState().changing) return;
  workspaceStore.setState({ changing: true });
  try {
    const snapshot = await api.command('project.open', { dir });
    show(snapshot);
    await refreshWorkspaces(api);
  } catch (error) {
    appStore.getState().notify('error', (error as Error).message);
  } finally { workspaceStore.setState({ changing: false }); flushWorkspaceEvents(appStore.getState()); }
}

export async function refreshWorkspaces(api: CommandApi = defaultApi): Promise<void> {
  const result = await api.command('workspace.list', {});
  workspaceStore.setState(result);
}

export async function activateWorkspace(id: string, api: CommandApi = defaultApi): Promise<void> {
  if (workspaceStore.getState().changing) return;
  workspaceStore.setState({ changing: true });
  try {
    const snapshot = await api.command('workspace.activate', { id });
    show(snapshot);
    await refreshWorkspaces(api);
  } catch (error) { appStore.getState().notify('error', (error as Error).message); }
  finally { workspaceStore.setState({ changing: false }); flushWorkspaceEvents(appStore.getState()); }
}

export async function closeWorkspace(id: string): Promise<void> {
  if (workspaceStore.getState().changing) return;
  const workspace = workspaceStore.getState().workspaces.find((item) => item.id === id);
  if (!workspace) return;
  if (workspace.terminalCount && !window.confirm(`Fechar ${workspace.name} salva o canvas e encerra seus ${workspace.terminalCount} terminais. Continuar?`)) return;
  workspaceStore.setState({ changing: true });
  try {
    const scoped = createCommandApi((...args) => window.orquestra.invoke(...args), () => id);
    await scoped.command('project.close', {});
    selections.delete(id);
    forgetWorkspaceEvents(id);
    if (appStore.getState().project?.workspaceId === id) {
      setActiveWorkspace(undefined);
      appStore.getState().setProject(null);
    }
    await refreshWorkspaces();
  } catch (error) { appStore.getState().notify('error', (error as Error).message); }
  finally { workspaceStore.setState({ changing: false }); flushWorkspaceEvents(appStore.getState()); }
  const next = workspaceStore.getState().selectedId;
  const entry = workspaceStore.getState().workspaces.find((item) => item.id === next);
  if (!appStore.getState().project && entry?.status === 'open') await activateWorkspace(entry.id);
}
