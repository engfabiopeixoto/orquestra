import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  HostEvent,
  HostResult,
  QueueEntry,
  TerminalInfo,
  WorkspaceInfo,
} from '@orquestra/shared/host-protocol';
import { formatResetTime, formatWindowLabel } from '@orquestra/shared/usage-format';
import { remotePairResponseSchema } from '@orquestra/shared/remote';
import type { RemoteSnapshot } from '@orquestra/shared/remote-snapshot';
import { applyEventToSnapshot, replayEvents } from './snapshot';
import { TerminalScreen, type OutputBus, type OutputSignal } from './TerminalScreen';
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, type StoredAuth } from './storage';
import { effectiveTerminalState, modelLabelOf, sortTerminalsForMobile, terminalStateLabel } from './terminals';
import { RemoteWsClient, type ConnectionStatus } from './ws-client';

type Usage = HostResult<'usage.codex'>;
type UsageProvider = 'codex' | 'claude' | 'agy';

export function initialPairToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('pair')?.trim() ?? '';
}

function wsUrlForCurrentOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function workspaceStatusLabel(status: WorkspaceInfo['status']): string {
  switch (status) {
    case 'open':
      return 'Aberto';
    case 'opening':
      return 'Abrindo';
    case 'closing':
      return 'Fechando';
    case 'paused':
      return 'Pausado';
  }
}

export function PairScreen({
  initialToken,
  onPaired,
}: {
  initialToken: string;
  onPaired: (auth: StoredAuth) => void;
}) {
  const [pairToken, setPairToken] = useState(initialToken);
  const [deviceName, setDeviceName] = useState('Celular');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pairToken.trim()) return setError('Abra pelo QR code ou cole o código de pareamento.');
    if (!deviceName.trim()) return setError('Informe um nome para este aparelho.');
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairToken: pairToken.trim(), deviceName: deviceName.trim() }),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        throw new Error(`Resposta inesperada do computador (HTTP ${response.status}). Confira se o acesso remoto está ligado.`);
      }
      if (!response.ok) {
        const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
        throw new Error(typeof message === 'string' ? message : 'Não foi possível parear.');
      }
      const parsed = remotePairResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error('Resposta de pareamento inválida.');
      const auth: StoredAuth = { token: parsed.data.deviceToken, device: parsed.data.device };
      saveStoredAuth(auth);
      onPaired(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao parear.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mobile-shell">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Orquestra</h1>
        </div>
        <span className="badge">Pareamento</span>
      </header>
      <main className="page-content">
        <div className="card">
          <strong>Conectar este celular ao computador</strong>
          <p className="muted">
            O pareamento gera um token exclusivo para este aparelho. Você pode revogar o acesso a qualquer momento no desktop.
          </p>
          <form className="pair-form" onSubmit={(e) => void submit(e)}>
            <div className="field">
              <label htmlFor="device-name">Nome deste dispositivo</label>
              <input
                id="device-name"
                data-testid="pair-device-name"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Ex.: Pixel do Fábio"
                maxLength={60}
              />
            </div>
            {!initialToken || error ? (
              <div className="field">
                <label htmlFor="pair-token">Código de pareamento</label>
                <input
                  id="pair-token"
                  data-testid="pair-token-input"
                  value={pairToken}
                  onChange={(e) => setPairToken(e.target.value)}
                  placeholder="Cole o código do link ?pair=..."
                />
              </div>
            ) : null}
            {error ? (
              <div className="error-box" role="alert" data-testid="pair-error">
                {error}
              </div>
            ) : null}
            <button type="submit" className="primary" data-testid="pair-submit" disabled={loading}>
              {loading ? 'Pareando…' : 'Parear este aparelho'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

export function UsageSection({ client }: { client: RemoteWsClient }) {
  const [usage, setUsage] = useState<Partial<Record<UsageProvider, Usage>>>({});
  const [loading, setLoading] = useState<Partial<Record<UsageProvider, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<UsageProvider, string>>>({});

  const loadProvider = async (provider: UsageProvider) => {
    setLoading((prev) => ({ ...prev, [provider]: true }));
    setErrors((prev) => ({ ...prev, [provider]: undefined }));
    try {
      const result = await client.command(`usage.${provider}`, {});
      setUsage((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [provider]: err instanceof Error ? err.message : 'Indisponível.' }));
    } finally {
      setLoading((prev) => ({ ...prev, [provider]: false }));
    }
  };

  useEffect(() => {
    void loadProvider('codex');
    void loadProvider('claude');
  }, [client]);

  const providers: Array<{ id: UsageProvider; label: string; manual?: boolean }> = [
    { id: 'codex', label: 'Codex · ChatGPT' },
    { id: 'claude', label: 'Claude' },
    { id: 'agy', label: 'Antigravity', manual: true },
  ];

  return (
    <section className="usage-panel" aria-label="Uso das assinaturas">
      <h2 className="section-title">Uso das assinaturas</h2>
      <div className="page-content">
        {providers.map(({ id, label, manual }) => {
          const data = usage[id];
          const err = errors[id];
          const busy = Boolean(loading[id]);
          return (
            <div className="card" key={id}>
              <div className="usage-row">
                <strong>{label}</strong>
                <button type="button" onClick={() => void loadProvider(id)} disabled={busy}>
                  {busy ? 'Consultando…' : manual && !data ? 'Consultar' : 'Atualizar'}
                </button>
              </div>
              {err ? <div className="error-box">{err}</div> : null}
              {data?.windows.map((win, idx) => (
                <div key={idx}>
                  <div className="usage-row">
                    <span>{formatWindowLabel(win.label)}</span>
                    <span>
                      {win.usedPercent}% usado
                      {win.resetsAt && formatResetTime(win.resetsAt) ? ` · renova ${formatResetTime(win.resetsAt)}` : ''}
                    </span>
                  </div>
                  <div className="usage-bar" aria-hidden="true">
                    <div
                      className={`usage-bar-fill${win.usedPercent >= 90 ? ' high' : ''}`}
                      style={{ width: `${Math.min(100, Math.max(0, win.usedPercent))}%` }}
                    />
                  </div>
                </div>
              ))}
              {data?.credits ? (
                <div className="usage-row" data-testid={`usage-credits-${id}`}>
                  <span>Créditos</span>
                  <span>{data.credits}</span>
                </div>
              ) : null}
              {data?.details.map((detail, idx) => (
                <div className="usage-row" key={`d${idx}`}>
                  <span>{detail.label}</span>
                  <span>{detail.value}</span>
                </div>
              ))}
              {data && data.windows.length === 0 && !data.credits ? <span className="muted">Sem janelas de limite reportadas.</span> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const [pairCode] = useState(initialPairToken);

  // O código de pareamento sai da barra de endereço assim que é lido (não fica no histórico nem em Referer).
  useEffect(() => {
    if (pairCode && window.location.search.includes('pair=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [pairCode]);
  const [auth, setAuth] = useState<StoredAuth | null>(() => (pairCode ? null : loadStoredAuth()));
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<RemoteSnapshot | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [loadingList, setLoadingList] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeWorkspaceIdRef = useRef<string | null>(null);
  activeWorkspaceIdRef.current = activeSnapshot?.workspaceId ?? null;
  const [openTerminal, setOpenTerminal] = useState<string | null>(null);
  const outputListeners = useRef(new Set<(signal: OutputSignal) => void>());
  const bus = useMemo<OutputBus>(
    () => ({
      subscribe: (listener) => {
        outputListeners.current.add(listener);
        return () => void outputListeners.current.delete(listener);
      },
    }),
    [],
  );
  const activatingRef = useRef<string | null>(null);
  const bufferedEventsRef = useRef<HostEvent[]>([]);
  const openWorkspaceRef = useRef<(id: string) => Promise<void>>(async () => {});
  const refreshWorkspacesRef = useRef<(quiet?: boolean) => Promise<void>>(async () => {});

  const client = useMemo(() => {
    if (!auth) return null;
    return new RemoteWsClient({
      url: wsUrlForCurrentOrigin(),
      token: auth.token,
      onStatus: (nextStatus, device, reason) => {
        setStatus(nextStatus);
        setStatusReason(reason ?? null);
        if (device) {
          setAuth((prev) => (prev ? { ...prev, device } : prev));
        }
      },
      onOutputOverflow: ({ name }) => {
        for (const listener of outputListeners.current) listener({ kind: 'overflow', name });
      },
      onEvent: (event: HostEvent) => {
        if (event.type === 'terminal.output') {
          // A saída só importa à tela do terminal aberto, e só do workspace que o celular está vendo.
          if (event.workspaceId === activeWorkspaceIdRef.current) {
            for (const listener of outputListeners.current) listener({ kind: 'output', event });
          }
          return;
        }
        if (event.type === 'workspace.activated') {
          const viewing = activeWorkspaceIdRef.current;
          const activating = activatingRef.current;
          if (activating === event.workspaceId || viewing === event.workspaceId) return;
          // O PC trocou de workspace: o celular que estava vendo agentes acompanha; na lista só atualiza o destaque.
          if (viewing) void openWorkspaceRef.current(event.workspaceId);
          else void refreshWorkspacesRef.current(true);
          return;
        }
        if (event.workspaceId && event.workspaceId === activatingRef.current) {
          // Enquanto o snapshot é carregado, guarda os eventos para reaplicar por `sequence`.
          bufferedEventsRef.current.push(event);
          return;
        }
        if (event.workspaceId && event.workspaceId === activeWorkspaceIdRef.current) {
          setActiveSnapshot((prev) => (prev ? applyEventToSnapshot(prev, event) : prev));
          if (event.type === 'terminal.notice') {
            setNotices((prev) => ({ ...prev, [event.name]: event.message }));
          }
        }
        if (
          event.workspaceId &&
          (event.type === 'terminal.state' || event.type === 'terminal.added' || event.type === 'terminal.removed')
        ) {
          // Atualiza os contadores resumidos da lista de workspaces quando há mudança de estado.
          void refreshWorkspacesRef.current(true);
        }
      },
    });
  }, [auth?.token]);

  const refreshWorkspaces = async (quiet = false) => {
    if (!client) return;
    if (!quiet) {
      setLoadingList(true);
      setError(null);
    }
    try {
      const list = await client.command('workspace.list', {});
      setWorkspaces(list.workspaces);
      setSelectedId(list.selectedId);
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'Não foi possível carregar os workspaces.');
    } finally {
      if (!quiet) setLoadingList(false);
    }
  };
  refreshWorkspacesRef.current = refreshWorkspaces;

  useEffect(() => {
    if (!client) return;
    client.connect();
    return () => client.close();
  }, [client]);

  useEffect(() => {
    if (status === 'connected' && client) {
      void refreshWorkspaces();
      if (activeWorkspaceIdRef.current) {
        void openWorkspace(activeWorkspaceIdRef.current);
      }
    }
  }, [status, client]);

  const openWorkspace = async (id: string) => {
    if (!client) return;
    activatingRef.current = id;
    bufferedEventsRef.current = [];
    setActivatingId(id);
    setError(null);
    try {
      const snap = await client.command('workspace.activate', { id });
      const buffered = bufferedEventsRef.current;
      bufferedEventsRef.current = [];
      activatingRef.current = null;
      // Atualiza a referência junto com o estado: evento que chegue antes do re-render não pode ser descartado.
      activeWorkspaceIdRef.current = snap.workspaceId;
      setActiveSnapshot(replayEvents(snap, buffered));
      setOpenTerminal((current) => (current && snap.terminals.some((t) => t.name === current) ? current : null));
      setNotices({});
      setSelectedId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ativar o workspace.');
    } finally {
      activatingRef.current = null;
      bufferedEventsRef.current = [];
      setActivatingId(null);
    }
  };
  openWorkspaceRef.current = openWorkspace;

  const unpair = () => {
    clearStoredAuth();
    setAuth(null);
    setActiveSnapshot(null);
    setWorkspaces([]);
  };

  if (!auth) {
    return <PairScreen initialToken={pairCode} onPaired={(nextAuth) => setAuth(nextAuth)} />;
  }

  const connectionLabel =
    status === 'connected'
      ? 'Conectado'
      : status === 'reconnecting'
        ? 'Reconectando…'
        : status === 'revoked'
          ? 'Acesso revogado'
          : 'Conectando…';

  const dotClass =
    status === 'connected' ? 'connected' : status === 'revoked' || status === 'closed' ? 'disconnected' : 'connecting';

  if (status === 'revoked') {
    return (
      <div className="mobile-shell">
        <header className="topbar">
          <div className="topbar-left">
            <h1>Orquestra</h1>
          </div>
          <span className="badge">Desconectado</span>
        </header>
        <main className="page-content">
          <div className="error-box" role="alert">
            {statusReason ?? 'Este dispositivo foi revogado no computador.'}
          </div>
          <button type="button" className="primary" onClick={unpair}>
            Parear novamente
          </button>
        </main>
      </div>
    );
  }

  const openedTerminal = openTerminal && activeSnapshot ? activeSnapshot.terminals.find((t) => t.name === openTerminal) : undefined;
  if (client && activeSnapshot?.workspaceId && openedTerminal) {
    return (
      <div className="mobile-shell terminal-shell">
        <TerminalScreen
          client={client}
          workspaceId={activeSnapshot.workspaceId}
          terminal={openedTerminal}
          status={status}
          bus={bus}
          onBack={() => setOpenTerminal(null)}
        />
      </div>
    );
  }

  const sortedTerminals: TerminalInfo[] = activeSnapshot ? sortTerminalsForMobile(activeSnapshot.terminals) : [];

  return (
    <div className="mobile-shell">
      <header className="topbar">
        <div className="topbar-left">
          {activeSnapshot ? (
            <button
              type="button"
              className="ghost"
              data-testid="mobile-back-workspaces"
              onClick={() => {
                setActiveSnapshot(null);
                setOpenTerminal(null);
                void refreshWorkspaces();
              }}
            >
              ← Workspaces
            </button>
          ) : (
            <h1>Orquestra</h1>
          )}
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="ghost"
            data-testid="mobile-refresh"
            disabled={status !== 'connected' || loadingList}
            onClick={() => void (activeSnapshot?.workspaceId ? openWorkspace(activeSnapshot.workspaceId) : refreshWorkspaces())}
          >
            Atualizar
          </button>
          {!activeSnapshot ? (
            <button type="button" className="ghost danger" data-testid="mobile-unpair" onClick={unpair}>
              Desparear
            </button>
          ) : null}
        </div>
      </header>

      <div className="conn-banner" data-testid="mobile-conn-status">
        <span className="conn-pill">
          <span className={`conn-dot ${dotClass}`} />
          {connectionLabel}
        </span>
        <span className="muted">{auth.device.name}</span>
      </div>

      <main className="page-content">
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}

        {!activeSnapshot ? (
          <>
            <h2 className="section-title">Workspaces</h2>
            {workspaces.length === 0 ? (
              <div className="card empty-state" data-testid="workspaces-empty">
                {loadingList ? 'Carregando workspaces…' : 'Nenhum workspace aberto no computador.'}
              </div>
            ) : (
              workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  className={`card workspace-card${ws.id === selectedId ? ' is-selected' : ''}`}
                  data-testid={`workspace-card-${ws.id}`}
                  disabled={activatingId === ws.id || status !== 'connected'}
                  onClick={() => void openWorkspace(ws.id)}
                >
                  <div className="workspace-card-hd">
                    <span className="workspace-name">{ws.name}</span>
                    <span className="badge">{activatingId === ws.id ? 'Abrindo…' : workspaceStatusLabel(ws.status)}</span>
                  </div>
                  <span className="workspace-dir">{ws.dir}</span>
                  <div className="workspace-stats">
                    {ws.waiting > 0 ? (
                      <span className="badge state-waiting">{ws.waiting} esperando você</span>
                    ) : null}
                    {ws.busy > 0 ? <span className="badge state-busy">{ws.busy} ocupados</span> : null}
                    <span className="badge">
                      {ws.terminalCount} {ws.terminalCount === 1 ? 'terminal' : 'terminais'}
                    </span>
                  </div>
                </button>
              ))
            )}
          </>
        ) : (
          <>
            <h2 className="section-title" data-testid="active-workspace-title">
              Agentes · {activeSnapshot.name}
            </h2>
            {sortedTerminals.length === 0 ? (
              <div className="card empty-state">Nenhum terminal neste workspace.</div>
            ) : (
              sortedTerminals.map((terminal) => {
                const stateKind = effectiveTerminalState(terminal);
                const label = terminalStateLabel(terminal);
                const model = modelLabelOf(terminal);
                const queueEntries: QueueEntry[] = activeSnapshot.queues?.[terminal.name] ?? [];
                const notice = notices[terminal.name];
                return (
                  <article
                    key={terminal.name}
                    className={`card agent-card state-${stateKind}`}
                    data-testid={`agent-card-${terminal.name}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir terminal ${terminal.name}`}
                    onClick={() => setOpenTerminal(terminal.name)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setOpenTerminal(terminal.name);
                    }}
                  >
                    <div className="agent-hd">
                      <div className="agent-title-group">
                        <span className="agent-name">{terminal.name}</span>
                        <div className="agent-meta">
                          <span>{terminal.agent}</span>
                          {terminal.regente ? <span className="badge regente">regente</span> : null}
                          {model ? (
                            <span
                              className={`badge${terminal.model?.status === 'mismatch' ? ' mismatch' : ''}`}
                            >
                              {terminal.model?.status === 'mismatch' ? '⚠ ' : ''}
                              {model}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className={`badge state-${stateKind}`} data-testid={`agent-state-${terminal.name}`}>
                        {label}
                      </span>
                    </div>

                    {terminal.queued > 0 || queueEntries.length > 0 ? (
                      <ul className="agent-queue" aria-label={`Fila de ${terminal.name}`}>
                        {queueEntries.length > 0 ? (
                          queueEntries.map((entry) => (
                            <li key={entry.askId}>
                              <span>
                                <strong>{entry.from}:</strong> {entry.preview}
                              </span>
                              <small>{entry.status === 'running' ? 'em curso' : 'na fila'}</small>
                            </li>
                          ))
                        ) : (
                          <li>
                            <span>Pedidos aguardando execução</span>
                            <small>{terminal.queued}</small>
                          </li>
                        )}
                      </ul>
                    ) : null}

                    {notice ? <div className="notice-box">{notice}</div> : null}
                  </article>
                );
              })
            )}
            {client ? <UsageSection client={client} /> : null}
          </>
        )}
      </main>
    </div>
  );
}
