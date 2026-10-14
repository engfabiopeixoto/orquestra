import type { QueueEntry } from '@orquestra/shared/host-protocol';
import { useState } from 'react';
import { createCommandApi } from '../api';
import { appStore, useApp } from '../store';
import { QueuePanel } from './QueuePanel';

const api = createCommandApi(window.orquestra.invoke);
// Referência fixa: um [] novo a cada leitura faz o zustand renderizar sem parar.
const NO_QUEUE: QueueEntry[] = [];

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    appStore.getState().notify('error', (error as Error).message);
  }
}

export function ContextBar({ name, menu = false, onDone, onOpenMenu }: { name: string; menu?: boolean; onDone?(): void; onOpenMenu?(event: React.MouseEvent<HTMLButtonElement>): void }) {
  const queue = useApp((state) => state.queues[name] ?? NO_QUEUE);
  const view = useApp((state) => state.terminals[name]);
  const [showQueue, setShowQueue] = useState(false);
  const [pending, setPending] = useState(false);
  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    await run(action);
    setPending(false); onDone?.();
  };
  const presentation = (changes: { blurred?: boolean; locked?: boolean }) => act(async () => {
    await api.command('terminal.presentation', { name, ...changes });
    appStore.getState().setTerminalPresentation(name, changes);
  });

  const remove = () =>
    run(async () => {
      const busy = view && (view.state === 'busy' || view.queued > 0);
      if (busy && !window.confirm(`${name} está ocupado ou tem pedidos na fila. Remover mesmo assim?`)) return;
      await api.command('terminal.remove', { name });
    });

  return (
    <div className={menu ? 'ctx ctx-menu nodrag' : 'ctx nodrag'}>
      <button role={menu ? 'menuitem' : undefined} disabled={pending} data-testid="ctx-edit" onClick={() => { appStore.getState().setEditing(name); onDone?.(); }}>Editar</button>
      <button role={menu ? 'menuitem' : undefined} data-testid="ctx-queue" onClick={() => setShowQueue(!showQueue)}>
        Fila{queue.length > 0 ? <span className="badge">{queue.length}</span> : null}
      </button>
      <button
        data-testid="ctx-restart"
        role={menu ? 'menuitem' : undefined}
        disabled={pending}
        onClick={() =>
          void act(async () => {
            const info = await api.command('terminal.restart', { name });
            appStore.getState().replaceTerminal(name, info);
          })
        }
      >
        {view?.unloaded ? 'Recarregar' : 'Reiniciar'}
      </button>
      {menu ? <>
        <hr />
        <button role="menuitemcheckbox" aria-checked={Boolean(view?.blurred)} data-testid="ctx-blur" disabled={pending} onClick={() => void presentation({ blurred: !view?.blurred })}>{view?.blurred ? '✓ ' : ''}Desfocar</button>
        <button role="menuitem" data-testid="ctx-unload" disabled={pending || view?.unloaded} onClick={() => void act(async () => {
          if (view && (view.state === 'busy' || view.queued > 0) && !window.confirm(`Descarregar ${name} interrompe o trabalho e cancela sua fila. Continuar?`)) return;
          const info = await api.command('terminal.unload', { name });
          appStore.getState().replaceTerminal(name, info);
        })}>Descarregar</button>
        <button role="menuitem" data-testid="ctx-duplicate" disabled={pending} onClick={() => void act(async () => {
          const { info, rect } = await api.command('terminal.duplicate', { name });
          appStore.getState().addTerminal(info);
          appStore.getState().moveNode(info.name, { x: rect.x, y: rect.y });
          appStore.getState().resizeNode(info.name, { width: rect.width, height: rect.height });
        })}>Duplicar</button>
        <button role="menuitemcheckbox" aria-checked={Boolean(view?.locked)} data-testid="ctx-lock" disabled={pending} title="Impede mover e redimensionar o terminal" onClick={() => void presentation({ locked: !view?.locked })}>{view?.locked ? '✓ ' : ''}Bloquear</button>
        <hr />
      </> : onOpenMenu ? <button data-testid="ctx-more" aria-label="Mais opções" onClick={onOpenMenu}>⋯</button> : null}
      <button role={menu ? 'menuitem' : undefined} disabled={pending} data-testid="ctx-remove" className="warn" onClick={() => { void remove(); onDone?.(); }}>Remover</button>
      {showQueue ? (
        <QueuePanel
          entries={queue}
          onCancel={(askId) =>
            void run(async () => {
              const result = await api.command('prompt.cancel', { askId });
              if (!result.cancelled && result.terminalBusy) appStore.getState().notify('warn', 'O pedido já foi cancelado; o terminal ainda parece ocupado. Use Reiniciar para liberar a fila.');
              else if (!result.cancelled) appStore.getState().notify('warn', 'Esse pedido já tinha terminado.');
            })
          }
        />
      ) : null}
    </div>
  );
}
