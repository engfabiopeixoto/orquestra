import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import type { AppAction } from '../../../shared/app-action';
import { createCommandApi, type CommandApi } from '../api';
import { activateWorkspace, closeWorkspace, openProject } from '../project';
import { useApp } from '../store';
import { useWorkspaces, workspaceDot, workspaceSummary } from '../workspaces';
import { ProjectFileExplorer } from '../components/ProjectFileExplorer';
import { AboutDialog } from '../components/AboutDialog';
import { SplitHandle } from '../components/SplitHandle';
import { usePortalOverlay } from '../portal/modal-overlay';
import {
  clampProjectsHeight,
  EXPLORER_MIN_HEIGHT,
  PROJECTS_DEFAULT_HEIGHT,
  PROJECTS_MIN_HEIGHT,
  readProjectsHeight,
  writeProjectsHeight,
} from '../layout-prefs';
import { QUALITY_SHORTCUT_HINT } from './shortcuts';

type Recent = { dir: string; name: string; openedAt: string };
type Row = { dir: string; name: string; workspace?: WorkspaceInfo };
const defaultApi = createCommandApi((...args) => window.orquestra?.invoke(...args));
const sameDir = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type MenuItem = { id: string; label: string; hint?: string; action?: AppAction };
const MENU_ITEMS: MenuItem[] = [
  { id: 'toggle-quality', label: 'Painel de Qualidade', hint: QUALITY_SHORTCUT_HINT },
  { id: 'open-logs', action: 'open-logs', label: 'Abrir pasta de logs' },
  { id: 'reload', action: 'reload', label: 'Recarregar interface', hint: 'Ctrl+Shift+F5' },
  { id: 'devtools', action: 'devtools', label: 'Ferramentas do desenvolvedor', hint: 'F12' },
  { id: 'about', label: 'Sobre o Orquestra' },
  { id: 'quit', action: 'quit', label: 'Sair' },
];

export function Sidebar({
  api = defaultApi,
  openPath,
  onOpenPathHandled,
  onToggleQuality,
  onOpenSettings,
  onOpenPersonas,
}: {
  api?: CommandApi;
  openPath?: string | null;
  onOpenPathHandled?(): void;
  onToggleQuality?(): void;
  onOpenSettings(): void;
  onOpenPersonas(): void;
}) {
  const project = useApp((state) => state.project);
  const { workspaces, selectedId, changing } = useWorkspaces((state) => state);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectsHeight, setProjectsHeight] = useState<number | null>(() => readProjectsHeight());
  const [measuredDefaultHeight, setMeasuredDefaultHeight] = useState<number>(PROJECTS_DEFAULT_HEIGHT);
  const [availableBodyHeight, setAvailableBodyHeight] = useState<number>(() => Math.max(240, (window.innerHeight || 720) - 210));
  const asideRef = useRef<HTMLElement>(null);
  const recentProjectsRef = useRef<HTMLDivElement>(null);
  const projectKey = project?.workspaceId ?? project?.dir ?? '';
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  usePortalOverlay(menu !== null || aboutOpen);

  useEffect(() => {
    const el = asideRef.current;
    const recentEl = recentProjectsRef.current;
    const measure = () => {
      const asideHeight = el?.clientHeight ?? 0;
      const bodyHeight = asideHeight > 0 ? asideHeight - 190 : (window.innerHeight || 720) - 210;
      setAvailableBodyHeight(Math.max(PROJECTS_MIN_HEIGHT + EXPLORER_MIN_HEIGHT, bodyHeight));
      const natural = recentEl?.clientHeight ?? 0;
      if (natural > 0) setMeasuredDefaultHeight(natural);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer) {
      if (el) observer.observe(el);
      if (recentEl) observer.observe(recentEl);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    void api.command('recent.list', {}).then((result) => setRecent(result.projects)).catch(() => setRecent([]));
  }, [api, project]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [menu]);

  const open = async (dir: string) => {
    if (project?.dir === dir) return;
    await openProject(dir, api);
  };

  const choose = async (row: Row) => {
    const { workspace } = row;
    if (!workspace) return open(row.dir);
    if (workspace.id === selectedId && project?.workspaceId === workspace.id) return;
    await activateWorkspace(workspace.id, api);
  };

  const pick = async () => {
    const dir = await window.orquestra.pickFolder();
    if (dir) await open(dir);
  };

  const toggleMenu = () => {
    const box = menuButtonRef.current?.getBoundingClientRect();
    setMenu((current) => current ? null : { x: box?.left ?? 10, y: (box?.bottom ?? 40) + 4 });
  };

  const run = (item: MenuItem) => {
    setMenu(null);
    if (item.id === 'about') setAboutOpen(true);
    else if (item.id === 'toggle-quality') onToggleQuality?.();
    else if (item.action) void window.orquestra?.appAction(item.action);
  };

  // Workspaces abertos fora dos recentes ficam no topo, para nunca sumirem.
  const rows: Row[] = [
    ...workspaces.filter((workspace) => !recent.some((item) => sameDir(item.dir, workspace.dir))).map((workspace) => ({ dir: workspace.dir, name: workspace.name, workspace })),
    ...recent.map((item) => ({ dir: item.dir, name: item.name, workspace: workspaces.find((workspace) => sameDir(workspace.dir, item.dir)) })),
  ];
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.dir.toLowerCase().includes(needle));
  const maxProjectsHeight = Math.max(PROJECTS_MIN_HEIGHT, availableBodyHeight - EXPLORER_MIN_HEIGHT);
  const effectiveProjectsHeight = clampProjectsHeight(
    projectsHeight ?? measuredDefaultHeight,
    availableBodyHeight,
  );
  const explorerPane = useMemo(
    () =>
      project ? (
        <ProjectFileExplorer
          key={projectKey}
          api={api}
          projectDir={project.dir}
          openPath={openPath}
          onOpenPathHandled={onOpenPathHandled}
        />
      ) : (
        <div className="file-explorer-empty muted">Abra um projeto para navegar pelos arquivos.</div>
      ),
    [project?.dir, projectKey, api, openPath, onOpenPathHandled],
  );

  return (
    <aside ref={asideRef} className="side">
      <div className="brand">
        <img className="logo" src={new URL('../assets/orquestra-icon.png', import.meta.url).href} alt="" />
        <span className="brand-name">Orquestra</span>
        <button ref={menuButtonRef} className="brand-menu" aria-label="Menu do Orquestra" aria-haspopup="menu" aria-expanded={menu !== null} onClick={toggleMenu}>⋯</button>
      </div>
      <div className="side-sec">
        <span>PROJETOS</span>
        <span className="side-sec-actions">
          <span className="workspace-count" title="Máximo de três workspaces simultâneos">{workspaces.length}/3</span>
          <button className="side-add" disabled={changing} data-testid="open-project" title="Abrir pasta…" onClick={() => void pick()}>+</button>
        </span>
      </div>
      <input className="side-filter" data-testid="recent-filter" placeholder="Filtrar" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div
        ref={recentProjectsRef}
        className="recent-projects"
        style={projectsHeight !== null ? { height: effectiveProjectsHeight, maxHeight: 'none' } : undefined}
      >
      {shown.length === 0 ? <p className="muted">{rows.length === 0 ? 'Nenhum projeto aberto ainda.' : 'Nada encontrado.'}</p> : null}
      {shown.map((row) => {
        const { workspace } = row;
        const on = workspace ? workspace.id === selectedId : project?.dir.toLowerCase() === row.dir.toLowerCase();
        return (
          <div key={row.dir} className="proj-row">
            <button
              className={`proj${on ? ' is-on' : ''}${workspace ? ' has-status' : ''}`}
              {...(workspace ? { role: 'tab', 'aria-selected': on } : {})}
              data-testid={workspace ? `workspace-${row.name}` : `recent-${row.name}`}
              title={row.dir}
              disabled={workspace ? changing : false}
              onClick={() => void choose(row)}
            >
              {workspace ? <span className={`workspace-dot ${workspaceDot(workspace)}`} /> : null}
              <span className="proj-name">{row.name}</span>
              {workspace ? <small>{workspaceSummary(workspace)}</small> : null}
            </button>
            {workspace ? <button className="proj-close" disabled={changing} title={`Fechar ${workspace.name}`} aria-label={`Fechar workspace ${workspace.name}`} onClick={() => void closeWorkspace(workspace.id)}>×</button> : null}
          </div>
        );
      })}
      </div>
      <SplitHandle
        orientation="horizontal"
        ariaLabel="Ajustar altura da lista de projetos"
        value={effectiveProjectsHeight}
        min={PROJECTS_MIN_HEIGHT}
        max={maxProjectsHeight}
        testId="projects-resizer"
        title="Arraste ou dê duplo clique para restaurar a altura padrão"
        onChange={(next) => setProjectsHeight(clampProjectsHeight(next, availableBodyHeight))}
        onCommit={(finalHeight) => {
          const clamped = clampProjectsHeight(finalHeight, availableBodyHeight);
          setProjectsHeight(clamped);
          writeProjectsHeight(clamped);
        }}
        onReset={() => {
          setProjectsHeight(null);
          writeProjectsHeight(null);
        }}
      />
      {explorerPane}
      <div className="side-foot">
        <button className="side-btn" data-testid="open-personas" onClick={onOpenPersonas}>Funções</button>
        <button className="side-btn" data-testid="open-settings" onClick={onOpenSettings}>Padrões dos agentes</button>
      </div>
      {menu ? createPortal(<div ref={menuRef} className="ctx ctx-menu app-menu" role="menu" aria-label="Menu do Orquestra" style={{ position: 'fixed', left: menu.x, top: menu.y }}>
        {MENU_ITEMS.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            aria-label={item.label}
            title={item.hint}
            disabled={item.id === 'toggle-quality' && (!project || !onToggleQuality)}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            {item.hint ? <small className="menu-hint">{item.hint}</small> : null}
          </button>
        ))}
      </div>, document.body) : null}
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
    </aside>
  );
}
