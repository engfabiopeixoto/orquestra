import type { Settings } from '@orquestra/shared/args';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { createCommandApi } from './api';
import { Canvas } from './canvas/Canvas';
import { Palette } from './canvas/Palette';
import { Sidebar } from './canvas/Sidebar';
import { ZoomControl } from './canvas/ZoomControl';
import { EditTerminalDialog } from './components/EditTerminalDialog';
import { NewTerminalDialog } from './components/NewTerminalDialog';
import { NoticeList } from './components/NoticeList';
import { PersonasDialog } from './components/PersonasDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { SubscriptionUsage } from './components/SubscriptionUsage';
import { activateWorkspace } from './project';
import { useWorkspaces } from './workspaces';
import { suggestNoteName } from './notes/suggest-name';
import { appStore, layoutOf, useApp } from './store';
import type { Position } from '@orquestra/shared/workspace';
import { GroupDialog, type GroupDraft } from './groups/GroupDialog';
import { GroupMembersDialog } from './groups/GroupMembersDialog';
import { GroupUIContext } from './groups/ui-actions';
import { selectionMembers } from './groups/helpers';
import { portalStore } from './portal/portal-state';
import { FlowWorkbench, FlowToolbar } from './flow/FlowWorkbench';

const globalApi = createCommandApi(window.orquestra.invoke);

export function App() {
  const project = useApp((state) => state.project);
  const api = useMemo(() => createCommandApi(window.orquestra.invoke, () => project?.workspaceId), [project?.workspaceId]);
  const { workspaces, selectedId, changing } = useWorkspaces((state) => state);
  const paused = workspaces.find((item) => item.id === selectedId);
  const terminals = useApp((state) => state.terminals);
  const editing = useApp((state) => state.editing);
  const [creating, setCreating] = useState(false);
  const [defaultArgs, setDefaultArgs] = useState<Settings['defaultArgs']>({ claude: [], agy: [], codex: [] });
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [personas, setPersonas] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [personasOpen, setPersonasOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState<string | undefined>();
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [managingGroup, setManagingGroup] = useState<string | null>(null);

  useEffect(() => {
    void globalApi.command('settings.get', {}).then((settings) => setSnapToGrid(settings.canvas?.snapToGrid ?? true)).catch(() => {});
  }, []);
  useEffect(() => { setCreating(false); setPersonasOpen(false); setCreatingGroup(undefined); setGroupDraft(null); setManagingGroup(null); }, [project?.workspaceId]);

  useEffect(() => {
    let previous: boolean | undefined;
    const sync = () => {
      const blocked = Boolean(document.querySelector('[role="dialog"], .ctx-menu, .workspace-changing, .usage-details:not([hidden])'));
      if (blocked !== previous) { previous = blocked; void window.orquestra?.portal?.setModalState(blocked); }
    };
    const observer = new MutationObserver(sync); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-expanded'] }); sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    portalStore.getState().loadFromStorage(project?.workspaceId || 'default');
    if (project?.workspaceId) void api.command('portal.registry', {}).then(({ portals }) => {
      for (const portal of portals) if (!portalStore.getState().portals[portal.id]) portalStore.getState().setPortal({ id: portal.id, workspaceId: project.workspaceId!, activeTabId: 'tab-1', tabs: [{ id: 'tab-1', url: 'about:blank', title: portal.title, isLoading: false, canGoBack: false, canGoForward: false }], mode: 'desktop', presetId: 'desktop-compact', orientation: 'portrait', zoomLevel: 1, isAttached: false, visible: false });
    }).catch(() => {});
  }, [project?.workspaceId]);

  const openNewTerminal = async (groupId?: string) => {
    setCreatingGroup(groupId);
    try {
      setDefaultArgs((await api.command('settings.get', {})).defaultArgs);
    } catch {
      // Sem padrões, o diálogo abre com o campo vazio.
      setDefaultArgs({ claude: [], agy: [], codex: [] });
    }
    try {
      setPersonas((await api.command('persona.list', {})).personas.map((persona) => persona.name));
    } catch {
      setPersonas([]);
    }
    if (appStore.getState().project?.workspaceId === project?.workspaceId) setCreating(true);
  };

  const create = async (input: {
    name: string;
    agent: 'claude' | 'agy' | 'codex' | 'shell';
    cwd: string;
    resume: boolean;
    args: string[];
    regente: boolean;
    persona?: string;
    monitor: boolean;
  }) => {
    const info = await api.command('terminal.create', { ...input, ...(creatingGroup ? { groupId: creatingGroup } : {}) });
    appStore.getState().addTerminal(info);
    if (creatingGroup) appStore.getState().applyGroupLayout(await api.command('group.layout', {}));
    setCreating(false);
  };

  const createNote = async (groupId?: string) => {
    const state = appStore.getState();
    const name = suggestNoteName([...Object.keys(state.terminals), ...Object.keys(state.notes)]);
    try {
      appStore.getState().upsertNote(await api.command('note.create', { name, content: '', ...(groupId ? { groupId } : {}) }));
      if (groupId) { appStore.getState().applyGroupLayout(await api.command('group.layout', {})); return; }
      // Sem rect, o store escolheu a próxima posição livre; o núcleo grava a mesma.
      const rect = layoutOf(appStore.getState(), name);
      if (rect) await api.command('layout.update', { nodes: [{ name, ...rect }] });
    } catch (error) {
      appStore.getState().notify('error', (error as Error).message);
    }
  };

  const newGroup = (fromSelection: boolean, position?: Position) => {
    const state = appStore.getState();
    const viewport = state.canvasViewport ?? state.viewport ?? { x: 0, y: 0, zoom: 1 };
    setGroupDraft({ members: fromSelection ? selectionMembers(state) : [], position: position ?? { x: (80 - viewport.x) / viewport.zoom, y: (120 - viewport.y) / viewport.zoom } });
  };

  const createPortalNode = async () => {
    const wsId = project?.workspaceId || 'default';
    const state = appStore.getState();
    const viewport = state.canvasViewport ?? state.viewport ?? { x: 0, y: 0, zoom: 1 };
    const portalId = `portal-${Date.now()}`;
    const position: Position = {
      x: (140 - viewport.x) / viewport.zoom,
      y: (120 - viewport.y) / viewport.zoom,
    };
    try {
      const created = await window.orquestra?.portal?.create({
        portalId,
        workspaceId: wsId,
        initialUrl: 'https://duckduckgo.com',
        mode: 'desktop',
        presetId: 'desktop-compact',
        orientation: 'portrait',
        position,
      });
      if (created) {
        portalStore.getState().setPortal({ ...created, position });
      }
    } catch (error) {
      appStore.getState().notify('error', (error as Error).message);
    }
  };

  const requestRemove = async (name: string) => {
    const view = appStore.getState().terminals[name];
    const busy = view && (view.state === 'busy' || view.queued > 0);
    if (!window.confirm(busy ? `${name} está ocupado ou tem pedidos na fila. Remover mesmo assim?` : `Remover ${name}?`)) return;
    try {
      await api.command('terminal.remove', { name });
    } catch (error) {
      appStore.getState().notify('error', (error as Error).message);
    }
  };

  return (
    <FlowWorkbench api={api}>
      <GroupUIContext.Provider value={{
        edit: (id, focus) => { const group = appStore.getState().groups.find((group) => group.id === id); if (group) setGroupDraft({ group, members: group.members, position: group.position, focus }); },
        members: (id) => setManagingGroup(id),
        newTerminal: (id) => void openNewTerminal(id),
        newNote: (id) => void createNote(id),
      }}>
        <div className="app">
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} onOpenPersonas={() => setPersonasOpen(true)} />
          <div className="workspace-main">
          <div className="titlebar" />
          <main className="canvas">
            <ReactFlowProvider key={project?.workspaceId ?? 'paused'}>
            <FlowToolbar />
            <Palette onNewTerminal={() => void openNewTerminal()} onNewNote={() => void createNote()} onNewPortal={() => void createPortalNode()} onNewGroup={() => newGroup(false)} onGroupSelection={() => newGroup(true)} />
            {project ? <Canvas snapToGrid={snapToGrid} onRemoveRequest={(name) => void requestRemove(name)} onNewGroup={newGroup} /> : <div className="empty workspace-empty">{paused ? <><p>{paused.name} está pausado. Seus agentes serão iniciados ao ativar o workspace.</p><button onClick={() => void activateWorkspace(paused.id)}>Ativar workspace</button></> : <p>Abra uma pasta de projeto para começar.</p>}</div>}
            <ZoomControl />
            </ReactFlowProvider>
            <SubscriptionUsage api={globalApi} />
            <NoticeList />
          </main>
          </div>
        </div>
        {changing ? <div className="workspace-changing" role="status">Atualizando workspace…</div> : null}
        {creating && project ? (
          <NewTerminalDialog
            projectDir={project.dir}
            existingNames={Object.keys(terminals)}
            defaultArgs={defaultArgs}
            personas={personas}
            onCancel={() => setCreating(false)}
            onCreate={create}
          />
        ) : null}
        {editing ? <EditTerminalDialog name={editing} api={api} onClose={() => appStore.getState().setEditing(null)} /> : null}
        {settingsOpen ? <SettingsDialog api={api} onClose={() => setSettingsOpen(false)} onSnapToGridChange={setSnapToGrid} /> : null}
        {personasOpen ? <PersonasDialog api={api} hasProject={project !== null} onClose={() => setPersonasOpen(false)} /> : null}
        {groupDraft && project ? <GroupDialog key={groupDraft.group?.id ?? 'new'} draft={groupDraft} api={api} onClose={() => setGroupDraft(null)} /> : null}
        {managingGroup && project ? <GroupMembersDialog id={managingGroup} api={api} onClose={() => setManagingGroup(null)} /> : null}
      </GroupUIContext.Provider>
    </FlowWorkbench>
  );
}
