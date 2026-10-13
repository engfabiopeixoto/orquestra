import type { QueueEntry } from '@orquestra/shared';

export function QueuePanel({ entries, onCancel }: { entries: QueueEntry[]; onCancel(askId: string): void }) {
  if (entries.length === 0) return <div className="queue muted">Fila vazia.</div>;
  return (
    <ul className="queue">
      {entries.map((entry) => (
        <li key={entry.askId} className="queue-item">
          <span className={`queue-status st-${entry.status === 'running' ? 'busy' : 'idle'}`}>
            {entry.status === 'running' ? 'em curso' : 'na fila'}
          </span>
          <span className="queue-from">{entry.kind === 'prompt' ? `de ${entry.from}` : `resposta de ${entry.from}`}</span>
          <span className="queue-preview">{entry.preview}</span>
          {entry.kind === 'prompt' ? (
            <button className="queue-cancel" data-testid={`queue-cancel-${entry.askId}`} onClick={() => onCancel(entry.askId)}>
              Cancelar
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
