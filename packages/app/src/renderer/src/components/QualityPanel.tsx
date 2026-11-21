import { useEffect, useRef, useState } from 'react';
import { QUALITY_METRICS, type QualityMetric, type QualityReport } from '@orquestra/shared/quality-schema';
import type { CommandApi } from '../api';
import { QualityMetricCard, type QualityAgentTerminal } from './QualityMetricCard';

export function QualityPanel({
  api,
  projectDir,
  terminals,
  onOpenFile,
}: {
  api: CommandApi;
  projectDir: string;
  terminals: QualityAgentTerminal[];
  onOpenFile(path: string): void;
}) {
  const [report, setReport] = useState<QualityReport | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const projectDirRef = useRef(projectDir);
  projectDirRef.current = projectDir;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const req = ++requestIdRef.current;
    setReport(null);
    setMeasuring(false);
    setError(null);
    setStatusMessage(null);
    void api
      .command('quality.read', {})
      .then((res) => {
        if (mountedRef.current && requestIdRef.current === req) setReport(res.report);
      })
      .catch((failure) => {
        if (mountedRef.current && requestIdRef.current === req) {
          setError(failure instanceof Error ? failure.message : 'Não foi possível ler a qualidade.');
        }
      });
  }, [api, projectDir]);

  const measure = async () => {
    if (measuring) return;
    const req = ++requestIdRef.current;
    setMeasuring(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await api.command('quality.measure', {});
      if (mountedRef.current && requestIdRef.current === req) setReport(next);
    } catch (failure) {
      if (mountedRef.current && requestIdRef.current === req) {
        setError(failure instanceof Error ? failure.message : 'Não foi possível medir a qualidade.');
      }
    } finally {
      if (mountedRef.current && requestIdRef.current === req) setMeasuring(false);
    }
  };

  const askAgent = async (name: string, kind: 'coverage' | 'mutation') => {
    const startDir = projectDirRef.current;
    setError(null);
    setStatusMessage(null);
    try {
      await api.command('quality.ask', { name, kind });
      if (mountedRef.current && projectDirRef.current === startDir) {
        setStatusMessage(`Pedido enviado para ${name}.`);
      }
    } catch (failure) {
      if (mountedRef.current && projectDirRef.current === startDir) {
        setError(failure instanceof Error ? failure.message : 'Não foi possível enviar o pedido ao agente.');
      }
    }
  };

  const orderedMetrics: QualityMetric[] = report
    ? QUALITY_METRICS.map(
        (id) => report.metrics.find((item) => item.id === id) ?? { id, signal: 'missing', value: null, delta: null },
      )
    : [];

  return (
    <section className="quality-panel" aria-label="Qualidade do projeto">
      <div className="side-sec quality-head">
        <span>QUALIDADE</span>
        <button
          type="button"
          className="quality-measure-btn"
          data-testid="quality-measure"
          disabled={measuring}
          onClick={() => void measure()}
        >
          {measuring ? 'Medindo…' : 'Medir'}
        </button>
      </div>

      {error ? <small className="usage-error" role="status">{error}</small> : null}
      {statusMessage ? <small className="quality-status muted" role="status">{statusMessage}</small> : null}

      <div className="quality-body">
        {!report && !measuring ? (
          <p className="muted quality-empty">Clique em Medir para analisar tamanho, complexidade e dependências do projeto.</p>
        ) : null}

        {report?.language === 'unsupported' ? (
          <p className="muted quality-empty">Por enquanto o painel só analisa projetos JavaScript e TypeScript.</p>
        ) : null}

        {report && report.language === 'js-ts' ? (
          <>
            <div className="quality-cards">
              {orderedMetrics.map((metric) => (
                <QualityMetricCard
                  key={metric.id}
                  metric={metric}
                  terminals={terminals}
                  staleCoverage={Boolean(report.coverage?.stale)}
                  onAskAgent={(name, kind) => void askAgent(name, kind)}
                />
              ))}
            </div>

            {report.changed.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Nos arquivos alterados</h3>
                <ul className="quality-list">
                  {report.changed.map((item, idx) => (
                    <li key={`${item.path}-${item.kind}-${idx}`}>
                      <button type="button" className="quality-file-btn" onClick={() => onOpenFile(item.path)}>
                        <span className="quality-item-path">{item.path}</span>
                        <small className="quality-item-detail">{item.detail}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.hotspots.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Pontos críticos</h3>
                <ul className="quality-list">
                  {report.hotspots.map((spot) => (
                    <li key={spot.path}>
                      <button type="button" className="quality-file-btn" onClick={() => onOpenFile(spot.path)}>
                        <span className="quality-item-path">{spot.path}</span>
                        <small className="quality-item-detail">{spot.reason}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.cycles.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Ciclos de import</h3>
                <ul className="quality-list">
                  {report.cycles.map((cycle, index) => (
                    <li key={`${cycle.typeOnly ? 'type' : 'rt'}-${index}`} className="quality-cycle-item">
                      <span className={`quality-cycle-kind ${cycle.typeOnly ? 'is-warn' : 'is-bad'}`}>
                        {cycle.typeOnly ? 'Só tipos' : 'Em execução'}
                      </span>
                      <div className="quality-cycle-files">
                        {cycle.files.map((filePath) => (
                          <button key={filePath} type="button" className="quality-link-btn" onClick={() => onOpenFile(filePath)}>
                            {filePath}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.functions.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Funções mais complexas</h3>
                <ul className="quality-list">
                  {report.functions.slice(0, 10).map((fn) => (
                    <li key={`${fn.path}:${fn.line}:${fn.name}`}>
                      <button type="button" className="quality-file-btn" onClick={() => onOpenFile(fn.path)}>
                        <span className="quality-item-path">{`${fn.name} (${fn.complexity})`}</span>
                        <small className="quality-item-detail">{`${fn.path}:${fn.line}`}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.limits.truncated || report.limits.skippedLarge > 0 ? (
              <footer className="quality-limits muted">
                {report.limits.truncated ? <span>Análise limitada aos primeiros 5.000 arquivos. </span> : null}
                {report.limits.skippedLarge > 0 ? <span>{report.limits.skippedLarge} arquivo(s) acima de 1 MB pulado(s).</span> : null}
              </footer>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
