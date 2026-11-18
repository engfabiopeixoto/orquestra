import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostEvent, ModelCatalogShape, TerminalInfo, TerminalKey } from './types';
import { TERMINAL_SEND_MAX_CHARS } from '@orquestra/shared/host-protocol';
import { createXtermView, fontSizeForWidth, type TerminalView } from './terminal-view';
import { effectiveTerminalState, modelLabelOf, terminalStateLabel } from './terminals';
import type { ConnectionStatus, RemoteWsClient } from './ws-client';

export type OutputSignal = { kind: 'output'; event: Extract<HostEvent, { type: 'terminal.output' }> } | { kind: 'overflow'; name: string };
export type OutputBus = { subscribe(listener: (signal: OutputSignal) => void): () => void };

const KEYS: Array<{ key: TerminalKey; label: string; aria: string }> = [
  { key: 'Enter', label: 'Enter', aria: 'Enter' },
  { key: 'Escape', label: 'Esc', aria: 'Esc' },
  { key: 'Tab', label: 'Tab', aria: 'Tab' },
  { key: 'ArrowUp', label: '↑', aria: 'Seta para cima' },
  { key: 'ArrowDown', label: '↓', aria: 'Seta para baixo' },
  { key: 'CtrlC', label: 'Ctrl+C', aria: 'Ctrl+C' },
  { key: 'Digit1', label: '1', aria: 'Tecla 1' },
  { key: 'Digit2', label: '2', aria: 'Tecla 2' },
  { key: 'Digit3', label: '3', aria: 'Tecla 3' },
];

type Pending =
  | { kind: 'restart' }
  | { kind: 'unload' }
  | { kind: 'reload' }
  | { kind: 'model'; model: string };

function confirmationText(pending: Pending, name: string): string {
  switch (pending.kind) {
    case 'restart':
      return `Reiniciar ${name}? O agente é encerrado e aberto de novo; o que estiver em andamento se perde.`;
    case 'unload':
      return `Descarregar ${name}? O terminal é encerrado e fica no canvas até ser recarregado.`;
    case 'reload':
      return `Recarregar ${name}? O agente é aberto de novo.`;
    case 'model':
      return `Trocar o modelo de ${name} para ${pending.model}?`;
  }
}

export function TerminalScreen({
  client,
  workspaceId,
  terminal,
  status,
  bus,
  onBack,
  createView = createXtermView,
}: {
  client: RemoteWsClient;
  workspaceId: string;
  terminal: TerminalInfo;
  status: ConnectionStatus;
  bus: OutputBus;
  onBack: () => void;
  createView?: (container: HTMLElement) => TerminalView;
}) {
  const name = terminal.name;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const readyRef = useRef(false);
  const loadSeq = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrolls, setScrolls] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelList, setModelList] = useState<Array<{ id: string; label: string }> | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const stateKind = effectiveTerminalState(terminal);
  const inactive = Boolean(terminal.unloaded) || terminal.state === 'exited';

  const load = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const seq = ++loadSeq.current;
    readyRef.current = false;
    try {
      client.subscribe(workspaceId, name);
      const snap = await client.command('terminal.snapshot', { name }, workspaceId);
      if (seq !== loadSeq.current) return;
      const width = containerRef.current?.clientWidth ?? 0;
      view.load(snap.data, snap.cols, snap.rows, width);
      setScrolls(fontSizeForWidth(width, snap.cols).scrollsHorizontally);
      readyRef.current = true;
      setNotice(null);
      setError(null);
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof Error ? err.message : 'Não foi possível carregar o terminal.');
    }
  }, [client, workspaceId, name]);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = createView(containerRef.current);
    viewRef.current = view;
    return () => {
      loadSeq.current++;
      readyRef.current = false;
      view.dispose();
      viewRef.current = null;
      client.unsubscribe(workspaceId, name);
    };
  }, [client, workspaceId, name, createView]);

  // Abre, reconecta ou troca a sessão do terminal (reinício, recarga): busca o retrato de novo.
  useEffect(() => {
    if (status === 'connected') void load();
  }, [status, terminal.id, load]);

  useEffect(
    () =>
      bus.subscribe((signal) => {
        if (signal.kind === 'overflow') {
          if (signal.name !== name) return;
          setNotice('Muita saída de uma vez: atualizando o terminal…');
          void load();
          return;
        }
        if (signal.event.name === name && readyRef.current) viewRef.current?.write(signal.event.data);
      }),
    [bus, name, load],
  );

  const run = async (action: () => Promise<unknown>, afterOk?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      afterOk?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const message = text.trim();
    if (!message || sending || inactive || status !== 'connected') return;
    setSending(true);
    setError(null);
    try {
      await client.command('terminal.send', { name, text: message }, workspaceId);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
    }
  };

  const pressKey = (key: TerminalKey) => {
    setError(null);
    client.command('terminal.key', { name, key }, workspaceId).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Não foi possível enviar a tecla.'));
  };

  const openModelPicker = async () => {
    setMenuOpen(false);
    await run(async () => {
      const catalog: ModelCatalogShape = await client.command('models.catalog', {});
      const agent = terminal.agent as keyof ModelCatalogShape;
      setModelList(catalog[agent]?.models ?? []);
    });
  };

  const confirm = () => {
    const action = pending;
    setPending(null);
    if (!action) return;
    void run(
      async () => {
        if (action.kind === 'unload') await client.command('terminal.unload', { name }, workspaceId);
        else if (action.kind === 'model') await client.command('terminal.model', { name, model: action.model }, workspaceId);
        else await client.command('terminal.restart', { name }, workspaceId);
      },
      () => void load(),
    );
  };

  const modelAgent = terminal.agent === 'claude' || terminal.agent === 'codex' || terminal.agent === 'agy';
  const model = modelLabelOf(terminal);
  const ctrlDisabled = inactive || status !== 'connected';
  const label = useMemo(() => terminalStateLabel(terminal), [terminal]);

  return (
    <div className="terminal-screen" data-testid="terminal-screen">
      <header className="topbar terminal-topbar">
        <button type="button" className="ghost" data-testid="terminal-back" onClick={onBack}>
          ← Agentes
        </button>
        <div className="terminal-title">
          <strong>{name}</strong>
          <span className={`badge state-${stateKind}`} data-testid="terminal-state">
            {label}
          </span>
          {model ? <span className="badge">{model}</span> : null}
        </div>
        <button type="button" className="ghost" aria-label="Mais ações" aria-haspopup="menu" aria-expanded={menuOpen} data-testid="terminal-menu" onClick={() => setMenuOpen((open) => !open)}>
          ⋮
        </button>
      </header>

      {menuOpen ? (
        <div className="menu-sheet" role="menu" data-testid="terminal-menu-sheet">
          <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); setPending({ kind: 'restart' }); }}>
            Reiniciar
          </button>
          {inactive ? (
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); setPending({ kind: 'reload' }); }}>
              Recarregar
            </button>
          ) : (
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); setPending({ kind: 'unload' }); }}>
              Descarregar
            </button>
          )}
          <button type="button" role="menuitem" disabled={busy || !modelAgent} onClick={() => void openModelPicker()}>
            Trocar modelo
          </button>
        </div>
      ) : null}

      {notice ? <div className="notice-box" data-testid="terminal-notice">{notice}</div> : null}
      {error ? (
        <div className="error-box" role="alert" data-testid="terminal-error">
          {error}
        </div>
      ) : null}
      {status !== 'connected' ? <div className="notice-box">Sem conexão com o computador. Reconectando…</div> : null}
      {terminal.unloaded ? <div className="notice-box">Este terminal está descarregado. Use ⋮ → Recarregar.</div> : null}

      <div className={`terminal-host${scrolls ? ' scrolls' : ''}`} data-testid="terminal-host">
        <div ref={containerRef} className="terminal-canvas" />
      </div>

      <div className="key-bar" role="toolbar" aria-label="Teclas">
        {KEYS.map(({ key, label: keyLabel, aria }) => (
          <button key={key} type="button" aria-label={aria} data-testid={`key-${key}`} disabled={ctrlDisabled} onClick={() => pressKey(key)}>
            {keyLabel}
          </button>
        ))}
      </div>

      <form
        className="send-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={1}
          value={text}
          maxLength={TERMINAL_SEND_MAX_CHARS}
          placeholder={`Mensagem para ${name}`}
          aria-label={`Mensagem para ${name}`}
          data-testid="send-input"
          disabled={inactive}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="primary" data-testid="send-submit" disabled={inactive || sending || status !== 'connected' || !text.trim()}>
          Enviar
        </button>
      </form>

      {modelList ? (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-label="Trocar modelo" data-testid="model-dialog">
            <strong>Trocar modelo de {name}</strong>
            <ul className="model-list">
              {modelList.map((option) => (
                <li key={option.id}>
                  <button type="button" onClick={() => { setModelList(null); setPending({ kind: 'model', model: option.id }); }}>
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setModelList(null)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-label="Confirmação" data-testid="confirm-dialog">
            <p>{confirmationText(pending, name)}</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setPending(null)}>
                Cancelar
              </button>
              <button type="button" className="primary" data-testid="confirm-yes" onClick={confirm}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
