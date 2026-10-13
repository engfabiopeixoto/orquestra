import { useState } from 'react';
import type { CanvasGroup, GroupMember, Position } from '@orquestra/shared/workspace';
import type { CommandApi } from '../api';
import { appStore } from '../store';
import { canvasElements } from './helpers';

const COLORS = ['#7aa7ff', '#4cc38a', '#b29aff', '#f2c66d', '#ec92ac', '#68ced4'];
export type GroupDraft = { group?: CanvasGroup; members: GroupMember[]; position: Position; focus?: 'title' | 'color' };
export function GroupDialog({ draft, api, onClose }: { draft: GroupDraft; api: CommandApi; onClose(): void }) {
  const selected = new Set(draft.members.map((member) => member.id));
  const hasTerminal = draft.members.some((member) => member.kind === 'terminal');
  const hasNote = draft.members.some((member) => member.kind === 'note');
  const hasFlow = draft.members.some((member) => member.kind === 'flow');
  const [title, setTitle] = useState(draft.group?.title ?? 'Novo grupo');
  const [color, setColor] = useState(draft.group?.color ?? COLORS[0]!);
  const [kind, setKind] = useState<CanvasGroup['kind']>(draft.group?.kind ?? (hasFlow || hasTerminal && hasNote ? 'mixed' : hasNote ? 'notes' : 'agents'));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const transfers = !draft.group && appStore.getState().groups.some((group) => group.members.some((member) => selected.has(member.id)));
  const submit = async () => {
    if (pending) return;
    if (!title.trim()) return setError('Informe um título para o grupo.');
    setPending(true); setError(null);
    try {
      if (!draft.group && draft.members.length) {
        const elements = canvasElements(appStore.getState()).filter((element) => selected.has(element.id));
        const ordinary = elements.filter((element) => element.kind !== 'flow');
        const processing = elements.filter((element) => element.kind === 'flow');
        if (ordinary.length) await api.command('layout.update', { nodes: ordinary.map((element) => ({ name: element.name, ...element.rect })) });
        if (processing.length) await api.command('flow.move', { nodes: processing.map((element) => ({ id: element.id, position: { x: element.rect.x, y: element.rect.y }, size: { width: element.rect.width, height: element.rect.height } })) });
      }
      const result = draft.group
        ? await api.command('group.update', { id: draft.group.id, title: title.trim(), color })
        : await api.command('group.create', { title: title.trim(), color, kind, members: draft.members, position: draft.position });
      appStore.getState().applyGroupLayout(result);
      onClose();
    } catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  };
  return <div className="dialog-backdrop" role="dialog" aria-label={draft.group ? 'Editar grupo' : 'Novo grupo'}>
    <form className="dialog group-dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>{draft.group ? 'Editar grupo' : 'Novo grupo'}</h2>
      <label>Título<input data-testid="group-title" autoFocus={draft.focus !== 'color'} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Cor<div className="group-color-picker">
        {COLORS.map((option) => <button key={option} type="button" aria-label={`Cor ${option}`} aria-pressed={color.toLowerCase() === option.toLowerCase()} style={{ background: option }} onClick={() => setColor(option)} />)}
        <input type="color" aria-label="Cor personalizada" autoFocus={draft.focus === 'color'} value={color} onChange={(event) => setColor(event.target.value)} />
      </div></label>
      {!draft.group ? <label>Tipo<select data-testid="group-kind" value={kind} disabled={draft.members.length > 0} onChange={(event) => setKind(event.target.value as CanvasGroup['kind'])}><option value="agents">Agentes</option><option value="notes">Anotações</option><option value="mixed">Misto</option></select></label> : null}
      {!draft.group ? <p className="muted">{draft.members.length === 1 ? 'Um elemento selecionado será incluído.' : draft.members.length ? `${draft.members.length} elementos selecionados serão incluídos.` : 'Grupo vazio. Adicione elementos pelo menu ou arraste-os para dentro.'}</p> : null}
      {transfers ? <p className="group-transfer">Os elementos selecionados serão transferidos de seus grupos atuais.</p> : null}
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" disabled={pending} onClick={onClose}>Cancelar</button><button type="submit" className="primary" data-testid="group-submit" disabled={pending}>{draft.group ? 'Salvar' : 'Criar'}</button></div>
    </form>
  </div>;
}
