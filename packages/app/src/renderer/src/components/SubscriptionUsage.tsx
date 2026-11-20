import { useEffect, useRef, useState } from 'react';
import type { HostResult } from '@orquestra/shared/host-protocol';
import type { CommandApi } from '../api';
import { usePortalOverlay } from '../portal/modal-overlay';
import { useApp } from '../store';

type Provider = 'codex' | 'claude' | 'agy';
type Usage = HostResult<'usage.codex'>;
// O Antigravity só é consultado sob pedido: cada consulta abre um agy, e o atualizador dele pisca uma janela de console.
const providers = [
  { id: 'codex', title: 'Codex · ChatGPT', automatic: true },
  { id: 'claude', title: 'Claude', automatic: true },
  { id: 'agy', title: 'Antigravity', automatic: false },
] as const;

function windowSummary(usage: Usage | undefined, period: '5h' | '7d'): string {
  if (!usage) return '—';
  const windows = usage.windows.filter((window) => period === '5h' ? /^(?:Gemini · |Claude \/ GPT · )?5\s*h$/.test(window.label) : /^(?:Gemini · |Claude \/ GPT · )?7\s*dias$/.test(window.label));
  if (!windows.length) return '—';
  return windows.map((window) => `${window.label.startsWith('Gemini') ? 'G ' : window.label.startsWith('Claude / GPT') ? 'C/G ' : ''}${window.usedPercent}%`).join(' · ');
}

function ProviderUsage({ id, title, automatic, api, externalUsage, onUsage }: { id: Provider; title: string; automatic: boolean; api: CommandApi; externalUsage?: Usage; onUsage(id: Provider, usage: Usage): void }) {
  const [usage, setUsage] = useState<Usage | null>(externalUsage ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const lastExternal = useRef<Usage | undefined>(undefined);
  useEffect(() => {
    if (!externalUsage || lastExternal.current === externalUsage) return;
    lastExternal.current = externalUsage;
    setError(null);
    setUsage(externalUsage);
    onUsage(id, externalUsage);
  }, [externalUsage, id, onUsage]);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const value = await api.command(`usage.${id}`, {});
      if (mounted.current) { setUsage(value); onUsage(id, value); }
    } catch (failure) {
      if (mounted.current) setError((failure as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!automatic) return () => { mounted.current = false; };
    void refresh();
    const timer = setInterval(() => void refresh(), id === 'claude' ? 300000 : 60000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [api, id, automatic]);
  return <section className="usage-provider-section" aria-label={`Assinatura ${title}`}>
    <div className="usage-heading"><strong>{title}</strong><button onClick={() => void refresh()} disabled={loading}>{loading ? 'Consultando…' : 'Atualizar'}</button></div>
    {!automatic && !usage && !loading && !error ? <p className="muted">Clique em Atualizar para consultar.</p> : null}
    {error ? <p role="status" className="usage-error">{error}{usage ? ' Os dados abaixo são da última consulta.' : ''}</p> : null}
    {usage?.windows.map((window, index) => <div className="usage-window" key={index}>
      <div className="usage-heading"><span>{window.label}</span><span>{window.usedPercent}% usado</span></div>
      <progress className={window.usedPercent >= 90 ? 'usage-high' : ''} max={100} value={window.usedPercent} aria-label={`Uso ${title} ${window.label}`} />
      {window.resetsAt ? <small>Renova em {new Date(window.resetsAt).toLocaleString('pt-BR')}</small> : null}
    </div>)}
    {usage && !usage.windows.length ? <p className="muted">A conta não retornou limites de assinatura.</p> : null}
    {usage?.credits !== null && usage?.credits !== undefined ? <p>Créditos: {usage.credits}</p> : null}
    {usage?.details?.map((detail) => <p className="usage-detail" key={detail.label}>{detail.label}: {detail.value}</p>)}
    {usage ? <small className="muted">Consultado às {new Date(usage.checkedAt).toLocaleTimeString('pt-BR')}</small> : null}
    <button className="usage-link" onClick={() => void window.orquestra.openSubscription(id)}>Abrir conta ↗</button>
  </section>;
}

export function SubscriptionUsage({ api }: { api: CommandApi }) {
  const [open, setOpen] = useState(false);
  usePortalOverlay(open);
  const [summary, setSummary] = useState<Partial<Record<Provider, Usage>>>({});
  const sharedUsage = useApp((state) => state.usage);
  const onUsage = (id: Provider, usage: Usage) => setSummary((previous) => (previous[id] === usage ? previous : { ...previous, [id]: usage }));
  return <aside className="subscription-usage nodrag nopan" aria-label="Uso das assinaturas">
    <button className="usage-toggle" aria-label="Uso das assinaturas" aria-expanded={open} aria-controls="subscription-details" onClick={() => setOpen(!open)}>
      <span className="usage-summary-title">◔ <span>Uso das<br />assinaturas</span></span>
      <span className="usage-periods"><span>5h</span><span>7d</span></span>
      {providers.map(({ id, title }) => <span key={id} className="usage-summary-provider" title={`${title} · porcentagem utilizada${id === 'agy' ? ' · G: Gemini; C/G: Claude e GPT' : ''}`}>
        <strong>{title.split(' · ')[0]}</strong><span className="usage-chip" data-testid={`usage-summary-${id}-5h`}>{windowSummary(summary[id], '5h')}</span><span className="usage-chip" data-testid={`usage-summary-${id}-7d`}>{windowSummary(summary[id], '7d')}</span>
      </span>)}
    </button>
    <div id="subscription-details" className="usage-details" hidden={!open}>
      {providers.map((provider) => <ProviderUsage key={provider.id} {...provider} api={api} externalUsage={sharedUsage[provider.id]} onUsage={onUsage} />)}
    </div>
  </aside>;
}
