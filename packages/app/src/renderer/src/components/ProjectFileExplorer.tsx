import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { HostResult, ProjectFile } from '@orquestra/shared/host-protocol';
import type { CommandApi } from '../api';

const labels = { none: '', added: 'Adições', modified: 'Adições e remoções', removed: 'Remoções' };
const badges = { none: '', added: 'A', modified: 'M', removed: 'R' };
type FileView = HostResult<'files.read'>;

export function ProjectFileExplorer({ api, projectDir }: { api: CommandApi; projectDir: string }) {
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [folders, setFolders] = useState<Record<string, HostResult<'files.list'>>>({});
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const selection = useRef(0);
  const refresh = async (version: number) => {
    if (pending.current) return;
    pending.current = true;
    const paths = [...expanded];
    const results = await Promise.allSettled(paths.map((path) => api.command('files.list', { path })));
    pending.current = false;
    if (version !== revision.current) return;
    const updates: Record<string, HostResult<'files.list'>> = {};
    let failure: string | null = null;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') updates[paths[index]!] = result.value;
      else failure = result.reason instanceof Error ? result.reason.message : 'Não foi possível ler os arquivos.';
    });
    setFolders((previous) => ({ ...previous, ...updates }));
    setError(failure);
  };
  useEffect(() => {
    const version = ++revision.current;
    void refresh(version);
    const timer = setInterval(() => { if (!document.hidden) void refresh(version); }, 2000);
    return () => { revision.current++; clearInterval(timer); };
  }, [api, projectDir, expanded]);

  const openFile = async (path: string) => {
    const version = ++selection.current;
    setSelected(path); setPreview(null); setPreviewError(null); setDiff(false);
    try {
      const value = await api.command('files.read', { path });
      if (selection.current === version) setPreview(value);
    } catch (failure) { if (selection.current === version) setPreviewError((failure as Error).message); }
  };
  const closePreview = () => { selection.current++; setSelected(null); setPreview(null); };
  useEffect(() => {
    if (!selected) return;
    const version = selection.current;
    let running = false;
    const timer = setInterval(async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const value = await api.command('files.read', { path: selected });
        if (selection.current === version) { setPreview(value); setPreviewError(null); }
      } catch (failure) { if (selection.current === version) setPreviewError((failure as Error).message); }
      finally { running = false; }
    }, 2000);
    return () => clearInterval(timer);
  }, [api, selected]);
  useEffect(() => {
    if (!selected) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closePreview(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selected]);
  useEffect(() => () => { selection.current++; }, []);
  const toggle = (path: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const key = (event: KeyboardEvent<HTMLButtonElement>, file: ProjectFile) => {
    if (event.key === 'ArrowRight' && file.kind === 'directory' && !expanded.has(file.path)) { event.preventDefault(); toggle(file.path); }
    if (event.key === 'ArrowLeft' && file.kind === 'directory' && expanded.has(file.path)) { event.preventDefault(); toggle(file.path); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.closest('[role=tree]')!.querySelectorAll<HTMLButtonElement>('[role=treeitem]'));
      const index = buttons.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
      buttons[index]?.focus();
    }
  };
  const needle = filter.trim().toLowerCase();
  const renderFolder = (path: string, depth: number): ReactNode => {
    const entries = (folders[path]?.entries ?? []).filter((entry) => entry.kind === 'directory' || !needle || entry.name.toLowerCase().includes(needle));
    return <ul role={path ? 'group' : 'tree'} aria-label={path ? undefined : 'Arquivos do projeto'}>
      {entries.map((entry) => <li role="none" key={entry.path}>
        <button role="treeitem" aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
          className={`file-row file-${entry.change}`} data-testid={`file-${entry.path}`} style={{ paddingLeft: 5 + depth * 12 }}
          title={`${entry.path}${labels[entry.change] ? ` · ${labels[entry.change]}` : ''}${entry.additions || entry.deletions ? ` (+${entry.additions} −${entry.deletions})` : ''}`}
          disabled={entry.kind === 'link'} onKeyDown={(event) => key(event, entry)}
          onClick={() => entry.kind === 'directory' ? toggle(entry.path) : void openFile(entry.path)}>
          <span className="file-icon" aria-hidden="true">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾' : '▸' : entry.kind === 'link' ? '↗' : '·'}</span>
          <span className="file-name">{entry.name}</span>
          {entry.change !== 'none' ? <span className="file-badge" aria-label={labels[entry.change]}>{badges[entry.change]}</span> : null}
        </button>
        {entry.kind === 'directory' && expanded.has(entry.path) ? folders[entry.path] ? renderFolder(entry.path, depth + 1) : <small className="muted file-loading">Carregando…</small> : null}
      </li>)}
    </ul>;
  };
  const shownText = diff ? preview?.diff : preview?.content;
  const previewLines = shownText?.split('\n') ?? [];
  return <section className="file-explorer" aria-label="Explorador de arquivos">
    <div className="side-sec">ARQUIVOS <button className="file-refresh" title="Atualizar arquivos" aria-label="Atualizar arquivos" onClick={() => void refresh(revision.current)}>↻</button></div>
    <input className="side-filter" placeholder="Filtrar arquivos" aria-label="Filtrar arquivos visíveis" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <div className="file-tree">{renderFolder('', 0)}{!folders[''] ? <small className="muted">Carregando…</small> : !folders[''].entries.length ? <small className="muted">Pasta vazia.</small> : null}</div>
    {error ? <small className="usage-error" role="status">{error}</small> : null}
    {Object.values(folders).some((folder) => folder.truncated) ? <small className="muted">Exibindo até 2.000 itens por pasta.</small> : null}
    <div className="file-legend"><span className="file-added">A adições</span><span className="file-modified">M alterações</span><span className="file-removed">R remoções</span></div>
    <small className="file-comparison">{folders['']?.comparison === 'git' ? 'Comparação com o último commit' : 'Comparação desde o acompanhamento'}</small>
    {selected ? <div className="dialog-backdrop file-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Arquivo ${selected}`} onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <div className="file-preview">
        <div className="file-preview-heading"><strong>{selected}</strong><button onClick={closePreview} autoFocus aria-label="Fechar arquivo">×</button></div>
        <div className="file-preview-tabs"><button className={!diff ? 'is-on' : ''} onClick={() => setDiff(false)}>Arquivo</button><button className={diff ? 'is-on' : ''} disabled={!preview?.diff} onClick={() => setDiff(true)}>Alterações</button><small className="muted">Pré-visualização</small></div>
        {previewError ? <p className="usage-error" role="status">{previewError}</p> : null}
        {!preview && !previewError ? <p className="muted">Carregando arquivo…</p> : null}
        {preview?.kind === 'binary' ? <p className="muted">Arquivo binário. A pré-visualização de texto não está disponível.</p> : preview?.kind === 'large' ? <p className="muted">Arquivo maior que 512 KB. A pré-visualização não está disponível.</p> : preview?.kind === 'removed' && !diff ? <p className="file-removed">Arquivo removido. Abra Alterações para ver o texto removido.</p> : null}
        {shownText !== null && shownText !== undefined ? <div className="file-code" tabIndex={0}>{previewLines.slice(0, 2000).map((line, index) => <div key={index} className={diff ? line.startsWith('+') && !line.startsWith('+++') ? 'code-added' : line.startsWith('-') && !line.startsWith('---') ? 'code-removed' : '' : ''}><span className="file-line-number">{index + 1}</span><code>{line || ' '}</code></div>)}</div> : null}
        {previewLines.length > 2000 ? <small className="muted">Pré-visualização limitada às primeiras 2.000 linhas.</small> : null}
      </div>
    </div> : null}
  </section>;
}
