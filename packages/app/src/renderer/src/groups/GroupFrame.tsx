import { NodeResizer, useViewport, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { GROUP_MIN, groupContains } from '@orquestra/shared/group-layout';
import { createCommandApi } from '../api';
import type { GroupFlowNode } from '../canvas/flow-nodes';
import { appStore, useApp } from '../store';
import { activeWorkspaceId } from '../workspace-context';
import { canvasElements, recoverGroupLayout } from './helpers';
import { useGroupUI } from './ui-actions';

export function GroupFrame({ data, selected }: NodeProps<GroupFlowNode>) {
  const state = useApp((state) => state);
  const group = state.groups.find((group) => group.id === data.groupId);
  const ui = useGroupUI();
  const { zoom } = useViewport();
  const api = useMemo(() => { const id = activeWorkspaceId(); return createCommandApi(window.orquestra.invoke, () => id); }, []);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pending, setPending] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [menu]);
  if (!group) return null;
  const elements = canvasElements(state).filter((element) => group.members.some((member) => member.id === element.id));
  const blocked = elements.find((element) => element.locked);
  const agents = Object.values(state.terminals).filter((terminal) => group.members.some((member) => member.kind === 'terminal' && member.id === terminal.id));
  const busy = agents.filter((agent) => agent.state === 'busy' || agent.queued > 0).length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const openMenu = (x: number, y: number) => setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 250)), y: Math.max(8, Math.min(y, window.innerHeight - 340)) });
  const perform = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try { await action(); setMenu(null); } catch (error) { await recoverGroupLayout(api, error); }
    finally { setPending(false); }
  };
  return <div className={`group-frame ${selected ? 'is-selected' : ''} ${data.dropTarget ? 'is-drop-target' : ''} ${group.locked || blocked ? 'is-fixed' : ''}`} data-testid={`group-${group.title}`} style={{ '--group-color': group.color, background: `${group.color}18` } as CSSProperties}>
    <NodeResizer isVisible={selected && !group.locked} minWidth={GROUP_MIN.width} minHeight={GROUP_MIN.height}
      shouldResize={(_event, rect) => elements.every((element) => groupContains({ ...group, position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }, element.rect))}
      onResizeEnd={(_event, rect) => void perform(async () => { appStore.getState().applyGroupLayout(await api.command('group.resize', { id: group.id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })); })} />
    <header className={`group-header ${zoom < 0.55 ? 'is-zoomed-out' : ''} ${group.locked || blocked ? 'nopan' : ''}`} data-testid={`group-header-${group.title}`} title={`${group.title} · ${blocked ? `Desbloqueie ${blocked.name} para mover o grupo inteiro.` : group.locked ? 'Quadro bloqueado' : 'Arraste pelo título para mover o conjunto'}`}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY); }}>
      <div><strong style={{ fontSize: Math.max(15, 9 / zoom), lineHeight: 1.1 }} onDoubleClick={(event) => { event.stopPropagation(); ui.edit(group.id); }}>{group.title}</strong><small>{group.members.length} {group.members.length === 1 ? 'elemento' : 'elementos'} · {group.kind === 'agents' ? 'Agentes' : group.kind === 'notes' ? 'Anotações' : 'Misto'}{busy ? ` · ${busy} trabalhando` : ''}{waiting ? ` · ${waiting} aguardando` : ''}{group.locked || blocked ? ' · bloqueado' : ''}</small></div>
      <button className="nodrag nopan" aria-label={`Opções do grupo ${group.title}`} data-testid={`group-options-${group.title}`} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.right - 245, rect.bottom + 4); }}>⋯</button>
    </header>
    {menu ? createPortal(<div className="ctx ctx-menu group-menu" role="menu" aria-label={`Grupo ${group.title}`} ref={menuRef} style={{ position: 'fixed', left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { ui.edit(group.id); setMenu(null); }}>Renomear</button>
      <button role="menuitem" onClick={() => { ui.edit(group.id, 'color'); setMenu(null); }}>Alterar cor</button>
      <hr />
      <button role="menuitem" onClick={() => { ui.newTerminal(group.id); setMenu(null); }}>Novo terminal neste grupo</button>
      <button role="menuitem" onClick={() => { ui.newNote(group.id); setMenu(null); }}>Nova anotação neste grupo</button>
      <button role="menuitem" data-testid="group-manage-members" onClick={() => { ui.members(group.id); setMenu(null); }}>Adicionar ou retirar elementos…</button>
      <hr />
      <button role="menuitem" disabled={pending || group.locked} onClick={() => void perform(async () => { appStore.getState().applyGroupLayout(await api.command('group.fit', { id: group.id })); })}>Ajustar aos elementos</button>
      <button role="menuitemcheckbox" aria-checked={group.locked} disabled={pending} onClick={() => void perform(async () => { appStore.getState().applyGroupLayout(await api.command('group.update', { id: group.id, locked: !group.locked })); })}>{group.locked ? 'Desbloquear quadro' : 'Bloquear quadro'}</button>
      <hr /><button role="menuitem" data-testid="group-ungroup" disabled={pending} onClick={() => void perform(async () => { appStore.getState().applyGroupLayout(await api.command('group.remove', { id: group.id })); })}>Desagrupar</button>
    </div>, document.body) : null}
  </div>;
}
