import { activateWorkspace, closeWorkspace } from '../project';
import { useWorkspaces } from '../workspaces';

export function WorkspaceTabs() {
  const { workspaces, selectedId, changing } = useWorkspaces((state) => state);
  return <div className="workspace-tabs" aria-label="Workspaces">
    <div className="workspace-tab-list" role="tablist" aria-label="Projetos abertos">
      {workspaces.map((workspace) => <div className={`workspace-tab ${workspace.id === selectedId ? 'is-on' : ''}`} key={workspace.id}>
        <button role="tab" aria-selected={workspace.id === selectedId} data-testid={`workspace-${workspace.name}`} disabled={changing} title={workspace.dir} onClick={() => void activateWorkspace(workspace.id)}>
          <span className={`workspace-dot ${workspace.waiting ? 'waiting' : workspace.busy ? 'busy' : workspace.status}`} />
          <span>{workspace.name}</span>
          <small>{workspace.status === 'paused' ? 'pausado' : `${workspace.terminalCount} agentes${workspace.busy ? ` · ${workspace.busy} ativos` : ''}${workspace.waiting ? ` · ${workspace.waiting} aguardando` : ''}`}</small>
        </button>
        <button className="workspace-close" disabled={changing} title={`Fechar ${workspace.name}`} aria-label={`Fechar workspace ${workspace.name}`} onClick={() => void closeWorkspace(workspace.id)}>×</button>
      </div>)}
    </div>
    <span className="workspace-count" title="Máximo de três workspaces simultâneos">{workspaces.length}/3</span>
  </div>;
}
