import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { createCommandApi } from './api';
import { App } from './App';
import { routeEvent } from './events';
import { outputBus } from './output-bus';
import { activateWorkspace, openProject, refreshWorkspaces, startupProject } from './project';
import { workspaceStore } from './workspaces';
import { appStore } from './store';

window.orquestra.onEvent((event) => routeEvent(event, { store: appStore.getState(), bus: outputBus }));
window.addEventListener('error', (event) => window.orquestra.reportError(event.message, event.error?.stack ?? ''));
window.addEventListener('unhandledrejection', (event) => window.orquestra.reportError(String(event.reason), ''));

createRoot(document.getElementById('root')!).render(<App />);

const api = createCommandApi(window.orquestra.invoke);

void (async () => {
  await refreshWorkspaces(api);
  if (window.orquestra.testProject) return openProject(window.orquestra.testProject);
  const { workspaces, selectedId } = workspaceStore.getState();
  if (workspaces.length) {
    if (workspaces.some((item) => item.id === selectedId && item.status === 'open')) await activateWorkspace(selectedId!);
    return; // Saved tabs stay paused after restarting the host.
  }
  const { projects } = await api.command('recent.list', {});
  const dir = startupProject(projects, null);
  if (dir) await openProject(dir);
})().catch((error) => appStore.getState().notify('error', (error as Error).message));

let refreshing = false;
setInterval(() => {
  if (document.hidden || refreshing || workspaceStore.getState().changing) return;
  refreshing = true;
  void refreshWorkspaces(api).catch(() => {}).finally(() => { refreshing = false; });
}, 2000);

window.orquestra.onFocusTerminal(async (name, workspaceId) => {
  if (workspaceId && appStore.getState().project?.workspaceId !== workspaceId) await activateWorkspace(workspaceId);
  if (appStore.getState().project?.workspaceId === workspaceId || !workspaceId) workspaceStore.setState({ focusRequest: { name, workspaceId } });
});
