import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostEvent, ModelCatalogShape, TerminalInfo, TerminalKey } from './types';
import { TERMINAL_SEND_MAX_CHARS } from '@orquestra/shared/host-protocol';
import { sameModel, type ModelAgent } from '@orquestra/shared/models';
import { createXtermView, fontSizeForWidth, type TerminalView } from './terminal-view';
import { effectiveTerminalState, modelLabelOf, terminalStateLabel } from './terminals';
import type { ConnectionStatus, RemoteWsClient } from './ws-client';

export type OutputSignal = { kind: 'output'; event: Extract<HostEvent, { type: 'terminal.output' }> } | { kind: 'overflow'; name: string };
export type OutputBus = { subscribe(listener: (signal: OutputSignal) => void): () => void };

const TERMINAL_MODE_KEY = 'orquestra.mobile.terminalMode';
const READING_THROTTLE_MS = 100;
const TEXTAREA_MAX_HEIGHT_PX = 112;

export type TerminalViewMode = 'reading' | 'terminal';

function loadTerminalMode(): TerminalViewMode {
  try {
    return localStorage.getItem(TERMINAL_MODE_KEY) === 'terminal' ? 'terminal' : 'reading';
  } catch {
    return 'reading';
  }
}

function saveTerminalMode(mode: TerminalViewMode): void {
  try {
    localStorage.setItem(TERMINAL_MODE_KEY, mode);
  } catch {}
}

const KEYS: Array<{ key: TerminalKey; label: string; aria: string }> = [
  { key: 'Enter', label: '↵', aria: 'Enter' },
  { key: 'Escape', label: 'Esc', aria: 'Esc' },
  { key: 'Tab', label: 'Tab', aria: 'Tab' },
  { key: 'ArrowUp', label: '↑', aria: 'Seta para cima' },
  { key: 'ArrowDown', label: '↓', aria: 'Seta para baixo' },
  { key: 'CtrlC', label: '^C', aria: 'Ctrl+C' },
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
  const stageRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readingRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const readyRef = useRef(false);
  const loadSeq = useRef(0);
  const autoFollowRef = useRef(true);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncAtRef = useRef(0);

  const [mode, setMode] = useState<TerminalViewMode>(loadTerminalMode);
  const modeRef = useRef<TerminalViewMode>(mode);
  modeRef.current = mode;
  const activeModelBtnRef = useRef<HTMLButtonElement | null>(null);
  const [readingText, setReadingText] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
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

  const syncReadingText = useCallback((immediate = false) => {
    const flush = () => {
      lastSyncAtRef.current = Date.now();
      setReadingText(viewRef.current?.readText?.() ?? '');
    };
    if (immediate) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      flush();
      return;
    }
    const elapsed = Date.now() - lastSyncAtRef.current;
    if (elapsed >= READING_THROTTLE_MS) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      flush();
    } else if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        flush();
      }, READING_THROTTLE_MS - elapsed);
    }
  }, []);

  const load = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const seq = ++loadSeq.current;
    readyRef.current = false;
    try {
      client.subscribe(workspaceId, name);
      const snap = await client.command('terminal.snapshot', { name }, workspaceId);
      if (seq !== loadSeq.current) return;
      const width = containerRef.current?.clientWidth || stageRef.current?.clientWidth || 0;
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
    const unsubUpdate = view.onUpdate?.((immediate) => {
      if (modeRef.current === 'reading') {
        syncReadingText(Boolean(immediate));
      }
    });
    return () => {
      loadSeq.current++;
      readyRef.current = false;
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      unsubUpdate?.();
      view.dispose();
      viewRef.current = null;
      client.unsubscribe(workspaceId, name);
    };
  }, [client, workspaceId, name, createView, syncReadingText]);

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
        if (signal.event.name === name && readyRef.current) {
          viewRef.current?.write(signal.event.data);
        }
      }),
    [bus, name, load],
  );

  useEffect(() => {
    if (mode === 'reading' && autoFollowRef.current && readingRef.current) {
      readingRef.current.scrollTop = readingRef.current.scrollHeight;
    }
  }, [readingText, mode]);

  useEffect(() => {
    if (mode === 'terminal' && readyRef.current) {
      const width = containerRef.current?.clientWidth || stageRef.current?.clientWidth || 0;
      const nextScrolls = viewRef.current?.fitWidth?.(width);
      if (typeof nextScrolls === 'boolean') setScrolls(nextScrolls);
    }
  }, [mode]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [text]);

  const handleReadingScroll = () => {
    const el = readingRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    autoFollowRef.current = atBottom;
    setShowScrollBottom(!atBottom);
  };

  const scrollToBottom = () => {
    autoFollowRef.current = true;
    setShowScrollBottom(false);
    if (readingRef.current) {
      readingRef.current.scrollTop = readingRef.current.scrollHeight;
    }
  };

  const toggleMode = () => {
    const next: TerminalViewMode = mode === 'reading' ? 'terminal' : 'reading';
    setMode(next);
    saveTerminalMode(next);
    if (next === 'reading') {
      autoFollowRef.current = true;
      setShowScrollBottom(false);
      syncReadingText(true);
    }
  };

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

  const activeModelOptionId = useMemo(() => {
    if (!modelList || !modelAgent) return null;
    const candidates = [terminal.model?.chosen, terminal.model?.effective].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (candidates.length === 0) return null;
    for (const candidate of candidates) {
      const norm = candidate.trim().toLowerCase();
      const exact = modelList.find((opt) => opt.id.toLowerCase() === norm || opt.label.toLowerCase() === norm);
      if (exact) return exact.id;
    }
    const agent = terminal.agent as ModelAgent;
    for (const candidate of candidates) {
      const matched = modelList.find((opt) => sameModel(agent, opt.id, candidate, modelList));
      if (matched) return matched.id;
    }
    return null;
  }, [modelList, modelAgent, terminal.agent, terminal.model?.chosen, terminal.model?.effective]);

  useEffect(() => {
    if (modelList) {
      activeModelBtnRef.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [modelList]);

  return (
    <div className="terminal-screen" data-testid="terminal-screen">
      <header className="topbar terminal-topbar">
        <div className="terminal-topbar-row">
          <button
            type="button"
            className="ghost terminal-back-btn"
            data-testid="terminal-back"
            aria-label="Voltar aos agentes"
            onClick={onBack}
          >
            ←
          </button>
          <strong className="terminal-name" title={name}>
            {name}
          </strong>
          <div className="topbar-actions">
            <button
              type="button"
              className="ghost mode-toggle"
              data-testid="terminal-mode-toggle"
              aria-pressed={mode === 'terminal'}
              aria-label={mode === 'reading' ? 'Modo Leitura, tocar para alternar para Terminal' : 'Modo Terminal, tocar para alternar para Leitura'}
              onClick={toggleMode}
            >
              {mode === 'reading' ? 'Leitura' : 'Terminal'}
            </button>
            <button type="button" className="ghost" aria-label="Mais ações" aria-haspopup="menu" aria-expanded={menuOpen} data-testid="terminal-menu" onClick={() => setMenuOpen((open) => !open)}>
              ⋮
            </button>
          </div>
        </div>
        <div className="terminal-topbar-meta">
          <span className={`badge compact state-${stateKind}`} data-testid="terminal-state">
            {label}
          </span>
          {model ? <span className="badge compact">{model}</span> : null}
        </div>
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

      <div ref={stageRef} className="terminal-stage">
        {mode === 'reading' ? (
          <>
            <div
              ref={readingRef}
              className="terminal-reading"
              data-testid="terminal-reading"
              onScroll={handleReadingScroll}
            >
              <pre className="terminal-reading-text">{readingText}</pre>
            </div>
            {showScrollBottom ? (
              <button
                type="button"
                className="scroll-bottom-btn"
                data-testid="terminal-scroll-bottom"
                onClick={scrollToBottom}
              >
                ↓ Ir ao fim
              </button>
            ) : null}
          </>
        ) : null}
        <div className={`terminal-host${scrolls ? ' scrolls' : ''}`} data-testid="terminal-host" hidden={mode !== 'terminal'}>
          <div ref={containerRef} className="terminal-canvas" />
        </div>
      </div>

      <div className="key-bar" role="toolbar" aria-label="Teclas">
        {KEYS.map(({ key, label: keyLabel, aria }) => (
          <button key={key} type="button" aria-label={aria} title={aria} data-testid={`key-${key}`} disabled={ctrlDisabled} onClick={() => pressKey(key)}>
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
          ref={inputRef}
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
              {modelList.map((option) => {
                const isCurrent = option.id === activeModelOptionId;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      ref={isCurrent ? activeModelBtnRef : undefined}
                      className={isCurrent ? 'is-current' : undefined}
                      aria-current={isCurrent ? 'true' : undefined}
                      data-testid={`model-option-${option.id}`}
                      onClick={() => { setModelList(null); setPending({ kind: 'model', model: option.id }); }}
                    >
                      <span>{option.label}</span>
                      {isCurrent ? <span className="model-check" aria-label="Em uso">✓</span> : null}
                    </button>
                  </li>
                );
              })}
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
