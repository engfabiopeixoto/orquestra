import { useEffect, useState } from 'react';
import { createCommandApi, type CommandApi } from '../api';
import { openProject } from '../project';
import { useApp } from '../store';
import { useWorkspaces } from '../workspaces';
import { ProjectFileExplorer } from '../components/ProjectFileExplorer';

type Recent = { dir: string; name: string; openedAt: string };
const defaultApi = createCommandApi((...args) => window.orquestra?.invoke(...args));

export function Sidebar({
  api = defaultApi,
  onOpenSettings,
  onOpenPersonas,
}: {
  api?: CommandApi;
  onOpenSettings(): void;
  onOpenPersonas(): void;
}) {
  const project = useApp((state) => state.project);
  const changing = useWorkspaces((state) => state.changing);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void api.command('recent.list', {}).then((result) => setRecent(result.projects)).catch(() => setRecent([]));
  }, [api, project]);

  const open = async (dir: string, _name: string) => {
    if (project?.dir === dir) return;
    await openProject(dir, api);
  };

  const pick = async () => {
    const dir = await window.orquestra.pickFolder();
    if (dir) await open(dir, dir.split(/[\\/]/).at(-1) ?? dir);
  };

  const needle = filter.trim().toLowerCase();
  const shown = recent.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.dir.toLowerCase().includes(needle));

  return (
    <aside className="side">
      <div className="brand"><img className="logo" src={new URL('../assets/orquestra-icon.png', import.meta.url).href} alt="" />Orquestra</div>
      <div className="side-sec">
        PROJETOS
        <button className="side-add" disabled={changing} data-testid="open-project" title="Abrir pasta…" onClick={() => void pick()}>+</button>
      </div>
      <input className="side-filter" data-testid="recent-filter" placeholder="Filtrar" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="recent-projects">
      {shown.length === 0 ? <p className="muted">{recent.length === 0 ? 'Nenhum projeto aberto ainda.' : 'Nada encontrado.'}</p> : null}
      {shown.map((item) => (
        <button
          key={item.dir}
          className={project?.dir.toLowerCase() === item.dir.toLowerCase() ? 'proj is-on' : 'proj'}
          data-testid={`recent-${item.name}`}
          title={item.dir}
          onClick={() => void open(item.dir, item.name)}
        >
          {item.name}
        </button>
      ))}
      </div>
      {project ? <ProjectFileExplorer key={project.dir} api={api} projectDir={project.dir} /> : <div className="file-explorer-empty muted">Abra um projeto para navegar pelos arquivos.</div>}
      <div className="side-foot">
        <button className="side-btn" data-testid="open-personas" onClick={onOpenPersonas}>Funções</button>
        <button className="side-btn" data-testid="open-settings" onClick={onOpenSettings}>Padrões dos agentes</button>
      </div>
    </aside>
  );
}
