import { useState } from 'react';
import type { CommandApi } from '../api';
import { appStore, useApp } from '../store';
import { canvasElements } from './helpers';

export function GroupMembersDialog({ id, api, onClose }: { id: string; api: CommandApi; onClose(): void }) {
  const state = useApp((state) => state);
  const group = state.groups.find((group) => group.id === id);
  const [selected, setSelected] = useState(() => new Set(group?.members.map((member) => member.id) ?? []));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!group) return null;
  const elements = canvasElements(state);
  const submit = async () => {
    if (pending) return;
    setPending(true);
    try {
      const members = elements.filter((element) => selected.has(element.id)).map(({ kind, id }) => ({ kind, id }));
      const result = await api.command('group.members', { id, members });
      appStore.getState().applyGroupLayout(result); onClose();
    } catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  };
  return <div className="dialog-backdrop" role="dialog" aria-label="Elementos do grupo"><form className="dialog group-members-dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2>Elementos de {group.title}</h2><p className="muted">Marque para incluir; desmarque para retirar. Elementos de outros grupos serão transferidos.</p>
    <div className="group-member-list">{elements.map((element) => {
      const owner = state.groups.find((group) => group.members.some((member) => member.id === element.id));
      return <label key={element.id}><input type="checkbox" data-testid={`group-member-${element.name}`} checked={selected.has(element.id)} onChange={(event) => setSelected((before) => { const next = new Set(before); if (event.target.checked) next.add(element.id); else next.delete(element.id); return next; })} /><span>{element.kind === 'flow' ? state.flow.graph.nodes.find((node) => node.id === element.id)?.title ?? element.name : element.name}<small>{element.kind === 'flow' ? 'Processamento' : element.kind === 'note' ? 'Anotação' : 'Terminal'}{owner ? ` · ${owner.title}` : ''}</small></span></label>;
    })}{!elements.length ? <p className="muted">Ainda não há elementos neste workspace.</p> : null}</div>
    {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    <div className="dialog-actions"><button type="button" disabled={pending} onClick={onClose}>Cancelar</button><button type="submit" className="primary" disabled={pending} data-testid="group-members-submit">Salvar</button></div>
  </form></div>;
}
