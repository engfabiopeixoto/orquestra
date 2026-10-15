import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { activeWorkspaceId } from '../workspace-context';
import { recoverGroupLayout } from '../groups/helpers';
import { NodeConnectors } from '../canvas/NodeConnectors';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CommandError, createCommandApi, type CommandApi } from '../api';
import type { NoteFlowNode } from '../canvas/flow-nodes';
import { appStore, layoutOf, useApp } from '../store';


export function NoteBody({ name, api }: { name: string; api: CommandApi }) {
  const note = useApp((state) => state.notes[name]);
  // baseRevision: revisão em que a edição começou, para o núcleo recusar se outro alterou no meio.
  const [draft, setDraft] = useState<{ text: string; baseRevision: number } | null>(null);
  if (!note) return null;

  const save = async (text: string, baseRevision: number | null) => {
    try {
      appStore.getState().upsertNote(await api.command('note.save', { name, content: text, baseRevision }));
      setDraft(null);
    } catch (error) {
      if (error instanceof CommandError && error.code === 'CONFLICT') appStore.getState().setNoteConflict(name, error.message);
      else appStore.getState().notify('error', (error as Error).message);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!draft) return;
    if (event.key === 'Escape') return setDraft(null);
    if (event.key === 's' && event.ctrlKey) {
      event.preventDefault();
      void save(draft.text, draft.baseRevision);
    }
  };

  if (note.conflict && draft) {
    return (
      <div className="note-conflict nodrag">
        <p>{note.conflict}</p>
        <div className="note-actions">
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              appStore.getState().setNoteConflict(name, null);
            }}
          >
            Recarregar
          </button>
          <button type="button" className="primary" onClick={() => void save(draft.text, null)}>
            Sobrescrever
          </button>
        </div>
      </div>
    );
  }

  if (draft) {
    return (
      <textarea
        className="note-editor nodrag nowheel"
        data-testid={`note-editor-${name}`}
        autoFocus
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onBlur={() => void save(draft.text, draft.baseRevision)}
        onKeyDown={onKeyDown}
      />
    );
  }

  return (
    <div className="note-view nowheel" data-testid={`note-view-${name}`} onDoubleClick={() => setDraft({ text: note.content, baseRevision: note.revision })}>
      {/* Link vira texto: um clique não pode trocar a página do app. */}
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span className="note-link">{children}</span> }}>
        {note.content}
      </Markdown>
    </div>
  );
}

export function NoteNode({ data, selected }: NodeProps<NoteFlowNode>) {
  const defaultApi = useMemo(() => { const id = activeWorkspaceId(); return createCommandApi(window.orquestra.invoke, () => id); }, []);
  const note = useApp((state) => state.notes[data.name]);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const renameFinished = useRef(false);
  useEffect(() => {
    if (editingName) nameInput.current?.focus();
  }, [editingName]);
  if (!note) return null;
  const beginRename = () => {
    renameFinished.current = false;
    setNameDraft(note.name);
    setEditingName(true);
  };
  const finishRename = (commit: boolean) => {
    if (renameFinished.current) return;
    renameFinished.current = true;
    setEditingName(false);
    const newName = nameDraft.trim();
    if (!commit || !newName || newName === note.name) return;
    void defaultApi.command('note.rename', { name: note.name, newName })
      .then((renamed) => appStore.getState().renameNote(note.name, renamed))
      .catch((error) => appStore.getState().notify('error', (error as Error).message));
  };
  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishRename(false);
    }
  };
  const sendLayout = () => {
    const rect = layoutOf(appStore.getState(), data.name);
    if (rect) void defaultApi.command('layout.update', { nodes: [{ name: data.name, ...rect }] }).catch((error) => recoverGroupLayout(defaultApi, error));
  };
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        onResizeEnd={(_event, params) => {
          appStore.getState().resizeNode(data.name, { width: params.width, height: params.height });
          appStore.getState().moveNode(data.name, { x: params.x, y: params.y });
          sendLayout();
        }}
      />
      <NodeConnectors />
      <div className={`note-node ${selected ? 'is-selected' : ''}`} data-testid={`note-${data.name}`}>
        <header className="note-hd">
          {editingName ? (
            <input
              ref={nameInput}
              className="note-name-editor nodrag nopan"
              data-testid="note-name-input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => finishRename(true)}
              onKeyDown={onRenameKeyDown}
            />
          ) : (
            <span className="note-name" onDoubleClick={(event) => { event.stopPropagation(); beginRename(); }}>{note.name}</span>
          )}
          <span className="note-by">por {note.updatedBy}</span>
        </header>
        <NoteBody name={data.name} api={defaultApi} />
      </div>
    </>
  );
}
