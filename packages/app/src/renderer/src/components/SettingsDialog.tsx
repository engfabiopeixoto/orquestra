import { canvasMotionSchema, formatArgs, parseArgs, reservedArgError, type CanvasMotion, type Settings } from '@orquestra/shared/args';
import type { RemoteDevice, RemotePairResult, RemoteStatus } from '@orquestra/shared/remote';
import { useEffect, useState } from 'react';
import type { CommandApi } from '../api';
import { ArgsField } from './ArgsField';
import { QrCode } from './QrCode';

const AGENTS = ['claude', 'agy', 'codex'] as const;

export function SettingsDialog({ api, onClose, onCanvasChange }: { api: CommandApi; onClose(): void; onCanvasChange?(canvas: Settings['canvas']): void }) {
  const [texts, setTexts] = useState<Record<(typeof AGENTS)[number], string> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [motion, setMotion] = useState<CanvasMotion>('contained');
  const [error, setError] = useState<string | null>(null);

  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDevice[]>([]);
  const [remotePairing, setRemotePairing] = useState<RemotePairResult | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .command('settings.get', {})
      .then((loaded) => {
        const normalized: Settings = {
          ...loaded,
          defaultArgs: { ...loaded.defaultArgs, codex: loaded.defaultArgs.codex ?? [] },
          canvas: { snapToGrid: loaded.canvas?.snapToGrid ?? true, motion: loaded.canvas?.motion ?? 'contained' },
        };
        setSettings(normalized);
        setSnapToGrid(normalized.canvas.snapToGrid);
        setMotion(normalized.canvas.motion);
        setTexts({ claude: formatArgs(normalized.defaultArgs.claude), agy: formatArgs(normalized.defaultArgs.agy), codex: formatArgs(normalized.defaultArgs.codex) });
      })
      .catch((loadError: Error) => {
        setSettings({ defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'contained' } });
        setTexts({ claude: '', agy: '', codex: '' });
        setError(loadError.message);
      });

    void api.command('remote.status', {}).then((status) => setRemoteStatus(status)).catch(() => {});
    void api.command('remote.devices', {}).then((res) => setRemoteDevices(res.devices)).catch(() => {});
  }, [api]);

  if (!texts) return null;

  const toggleRemote = async (enabled: boolean, fallbackHttp?: boolean) => {
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      const next = await api.command('remote.enable', fallbackHttp ? { enabled, fallbackHttp } : { enabled });
      setRemoteStatus(next);
      setRemotePairing(null);
    } catch (err) {
      setRemoteError((err as Error).message);
    } finally {
      setRemoteBusy(false);
    }
  };

  const pairRemote = async () => {
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      const pair = await api.command('remote.pair', {});
      setRemotePairing(pair);
    } catch (err) {
      setRemoteError((err as Error).message);
    } finally {
      setRemoteBusy(false);
    }
  };

  const revokeDevice = async (id: string) => {
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      await api.command('remote.revoke', { id });
      const [status, list] = await Promise.all([
        api.command('remote.status', {}),
        api.command('remote.devices', {}),
      ]);
      setRemoteStatus(status);
      setRemoteDevices(list.devices);
    } catch (err) {
      setRemoteError((err as Error).message);
    } finally {
      setRemoteBusy(false);
    }
  };

  const submit = async () => {
    const defaultArgs: Settings['defaultArgs'] = { claude: [], agy: [], codex: [] };
    for (const agent of AGENTS) {
      try {
        defaultArgs[agent] = parseArgs(texts[agent]);
      } catch (parseError) {
        return setError(`Padrão do ${agent}: ${(parseError as Error).message}`);
      }
      const reserved = reservedArgError(agent, defaultArgs[agent]);
      if (reserved) return setError(`Padrão do ${agent}: ${reserved}`);
    }
    try {
      const updated: Settings = { ...settings!, defaultArgs, canvas: { ...settings!.canvas, snapToGrid, motion } };
      await api.command('settings.update', updated);
      onCanvasChange?.(updated.canvas);
      onClose();
    } catch (saveError) {
      setError((saveError as Error).message);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-label="Padrões dos agentes">
      <form
        className="dialog settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Padrões dos agentes</h2>
        <p className="muted">Argumentos que já vêm preenchidos ao criar um terminal. Terminais existentes não mudam.</p>
        {AGENTS.map((agent) => (
          <label key={agent}>
            {agent}
            <ArgsField agent={agent} value={texts[agent]} onChange={(value) => setTexts({ ...texts, [agent]: value })} testId={`settings-${agent}`} />
          </label>
        ))}
        <label className="check">
          <input data-testid="settings-snap-grid" type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} />
          Grid magnético (encaixar elementos na grade)
        </label>
        <label>
          Animações do canvas
          <select data-testid="settings-motion" value={motion} onChange={(event) => setMotion(canvasMotionSchema.parse(event.target.value))}>
            <option value="contained">Contido</option>
            <option value="minimal">Mínimo</option>
          </select>
        </label>

        <fieldset className="remote-section" data-testid="settings-remote-section">
          <legend>Celular</legend>
          <label className="check">
            <input
              data-testid="settings-remote-enable"
              type="checkbox"
              checked={remoteStatus?.enabled ?? false}
              disabled={remoteBusy}
              onChange={(event) => void toggleRemote(event.target.checked)}
            />
            Acesso remoto pelo celular (127.0.0.1)
          </label>
          <div className="remote-meta">
            <span className="muted" data-testid="settings-remote-status">
              Estado: {remoteStatus?.enabled ? 'Ligado' : 'Desligado'}
            </span>
            {remoteStatus?.tailscale ? (
              <span className="muted" data-testid="settings-remote-tailscale-state">
                Tailscale:{' '}
                {remoteStatus.tailscale.state === 'serving'
                  ? `HTTPS ativo (${remoteStatus.tailscale.dnsName ?? 'tailnet'})`
                  : remoteStatus.tailscale.state === 'fallback'
                    ? 'Plano B ativo (HTTP no IP do Tailscale)'
                    : remoteStatus.tailscale.state === 'error'
                      ? 'Indisponível para HTTPS'
                      : 'Desligado'}
              </span>
            ) : null}
            {remoteStatus?.enabled && remoteStatus.tailscale?.url ? (
              <span className="muted" data-testid="settings-remote-tailscale-url">
                Endereço Tailscale: <code>{remoteStatus.tailscale.url}</code>
              </span>
            ) : null}
            {remoteStatus?.enabled ? (
              <span className="muted" data-testid="settings-remote-url">
                Endereço local: <code>{remoteStatus.localUrl}</code>
              </span>
            ) : null}
          </div>
          {remoteStatus?.enabled && remoteStatus.tailscale?.error ? (
            <div className="remote-fallback-box" data-testid="settings-remote-tailscale-error">
              <p className="dialog-error">{remoteStatus.tailscale.error}</p>
              {remoteStatus.tailscale.state !== 'fallback' && remoteStatus.tailscale.tailscaleIp ? (
                <button
                  type="button"
                  data-testid="settings-remote-fallback-btn"
                  disabled={remoteBusy}
                  onClick={() => void toggleRemote(true, true)}
                >
                  Ouvir também no IP do Tailscale (HTTP: {remoteStatus.tailscale.tailscaleIp}:{remoteStatus.port})
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="remote-actions">
            <button
              type="button"
              data-testid="settings-remote-pair"
              disabled={!remoteStatus?.enabled || remoteBusy}
              onClick={() => void pairRemote()}
            >
              Parear celular
            </button>
          </div>
          {remotePairing ? (
            <div className="remote-pair-box" data-testid="settings-remote-pair-box">
              <QrCode value={remotePairing.url} testId="settings-remote-qr" />
              <div className="remote-pair-info">
                <span className="muted">Link de uso único (expira em 5 min):</span>
                <input
                  readOnly
                  value={remotePairing.url}
                  data-testid="settings-remote-pair-url"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
            </div>
          ) : null}
          {remoteDevices.length > 0 ? (
            <ul className="remote-devices" data-testid="settings-remote-devices">
              {remoteDevices.map((device) => (
                <li key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <small className="muted">
                      {device.lastSeenAt ? `Último acesso: ${new Date(device.lastSeenAt).toLocaleString('pt-BR')}` : 'Nunca acessou'}
                    </small>
                  </div>
                  <button
                    type="button"
                    data-testid={`settings-remote-revoke-${device.id}`}
                    disabled={remoteBusy}
                    onClick={() => void revokeDevice(device.id)}
                  >
                    Revogar
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nenhum dispositivo pareado.</p>
          )}
          {remoteError ? <p className="dialog-error" data-testid="settings-remote-error">{remoteError}</p> : null}
        </fieldset>

        {error ? <p className="dialog-error" data-testid="settings-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" data-testid="settings-submit">Salvar</button>
        </div>
      </form>
    </div>
  );
}
