import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from '../../../shared/bridge';

const icon = new URL('../assets/orquestra-icon.png', import.meta.url).href;

export function AboutDialog({ onClose }: { onClose(): void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    void window.orquestra.getAppInfo().then(setInfo).catch((loadError: Error) => setError(loadError.message));
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const copyInfo = () => {
    if (!info) return;
    const text = [
      'Orquestra',
      `Versão: ${info.version}`,
      `Electron: ${info.electron}`,
      `Chromium: ${info.chrome}`,
      `Node: ${info.node}`,
      `Sistema operacional: ${info.platform} ${info.arch} ${info.osRelease}`,
    ].join('\n');
    void window.orquestra.writeClipboard(text).catch((copyError: Error) => setError(copyError.message));
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-label="Sobre o Orquestra">
      <section className="dialog about-dialog">
        <div className="about-brand">
          <img className="about-icon" src={icon} alt="" />
          <div>
            <h2>Orquestra</h2>
            {info ? <p>Versão {info.version}</p> : <p className="muted">Carregando informações…</p>}
          </div>
        </div>
        {info ? (
          <dl className="about-versions">
            <div><dt>Electron</dt><dd>{info.electron}</dd></div>
            <div><dt>Chromium</dt><dd>{info.chrome}</dd></div>
            <div><dt>Node</dt><dd>{info.node}</dd></div>
          </dl>
        ) : null}
        <p className="about-license">por engfabiopeixoto · licença MIT</p>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => void window.orquestra.appAction('open-repo')}>Ver no GitHub</button>
          <button type="button" disabled={!info} onClick={copyInfo}>Copiar informações</button>
          <button ref={closeButton} type="button" onClick={onClose}>Fechar</button>
        </div>
      </section>
    </div>
  );
}
