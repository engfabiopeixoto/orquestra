import { appStore, useApp } from '../store';

export function Palette({ onNewTerminal, onNewNote, onNewPortal, onNewGroup, onGroupSelection }: { onNewTerminal(): void; onNewNote(): void; onNewPortal?(): void; onNewGroup?(): void; onGroupSelection?(): void }) {
  const connectMode = useApp((state) => state.connectMode);
  const hasProject = useApp((state) => state.project !== null);
  const selectionMode = useApp((state) => state.selectionMode);
  const selected = useApp((state) => state.selectedNodes.filter((name) => state.terminals[name] || state.notes[name] || name.startsWith('flow:') && state.flow.graph.nodes.some((node) => `flow:${node.id}` === name)).length);
  return (
    <><div className="palette">
      <button className={!connectMode && !selectionMode ? 'tool is-on' : 'tool'} data-testid="palette-select" onClick={() => { appStore.getState().setConnectMode(false); appStore.setState({ selectionMode: false }); }}>
        Selecionar
      </button>
      <button className="tool" data-testid="palette-new-terminal" disabled={!hasProject} onClick={onNewTerminal}>
        + Terminal
      </button>
      <button className="tool" data-testid="palette-new-note" disabled={!hasProject} onClick={onNewNote}>
        + Nota
      </button>
      {onNewPortal ? (
        <button className="tool" data-testid="palette-new-portal" disabled={!hasProject} onClick={onNewPortal}>
          + Portal
        </button>
      ) : null}
      <button className={connectMode ? 'tool is-on' : 'tool'} data-testid="palette-connect" disabled={!hasProject} onClick={() => appStore.getState().setConnectMode(!connectMode)}>
        Conectar
      </button>
    </div>
    {onNewGroup ? <div className="group-tools" aria-label="Organizar grupos">
      <button className={selectionMode ? 'is-on' : ''} data-testid="palette-area-select" disabled={!hasProject} title="Selecione uma área do canvas. Shift + arraste também seleciona." onClick={() => { appStore.getState().setFocus(null); appStore.getState().setConnectMode(false); appStore.setState({ selectionMode: !selectionMode }); }}>Selecionar área</button>
      <button data-testid="palette-new-group" disabled={!hasProject} onClick={onNewGroup}>+ Grupo</button>
      <button data-testid="palette-group-selection" disabled={!hasProject || !selected} onClick={onGroupSelection}>Agrupar seleção{selected ? ` (${selected})` : ''}</button>
    </div> : null}</>
  );
}
