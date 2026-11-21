import { useEffect, useRef, useState } from 'react';
import { changedItemRefactorTarget, worstRefactorTarget } from '@orquestra/shared/quality-guide';
import { QUALITY_METRICS, type QualityMetric, type QualityReport } from '@orquestra/shared/quality-schema';
import type { CommandApi } from '../api';
import { QualityAskMenuButton } from './QualityAskMenuButton';
import { QualityMetricCard, type QualityAgentTerminal, type QualityAskRequest } from './QualityMetricCard';

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
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
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
    setOpenMenuId(null);
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
    setOpenMenuId(null);
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

  const askAgent = async (name: string, request: QualityAskRequest) => {
    const startDir = projectDirRef.current;
    setError(null);
    setStatusMessage(null);
    setOpenMenuId(null);
    try {
      await api.command('quality.ask', { name, ...request });
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
                  refactorTarget={metric.signal === 'warn' || metric.signal === 'bad' ? worstRefactorTarget(metric.id, report) : null}
                  openMenuId={openMenuId}
                  onOpenMenuChange={setOpenMenuId}
                  onAskAgent={(name, request) => void askAgent(name, request)}
                />
              ))}
            </div>

            {report.changed.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Nos arquivos alterados</h3>
                <ul className="quality-list">
                  {report.changed.map((item, idx) => {
                    const choice = changedItemRefactorTarget(item, report);
                    const menuId = `changed-${idx}`;
                    return (
                      <li key={`${item.path}-${item.kind}-${idx}`} className="quality-list-row">
                        <button type="button" className="quality-file-btn" onClick={() => onOpenFile(item.path)}>
                          <span className="quality-item-path">{item.path}</span>
                          <small className="quality-item-detail">{item.detail}</small>
                        </button>
                        {choice ? (
                          <QualityAskMenuButton
                            label="Refatorar"
                            className="quality-refactor-btn"
                            title={`Refatorar ${choice.label}`}
                            ariaLabel={`Refatorar alterado ${choice.label}`}
                            menuAriaLabel={`Escolher agente para alterado ${choice.label}`}
                            terminals={terminals}
                            open={openMenuId === menuId}
                            onOpenChange={(next) => setOpenMenuId(next ? menuId : null)}
                            onSelectTerminal={(name) => void askAgent(name, { kind: 'refactor', target: choice.target })}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {report.hotspots.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Pontos críticos</h3>
                <ul className="quality-list">
                  {report.hotspots.map((spot) => {
                    const menuId = `hotspot-${spot.path}`;
                    return (
                      <li key={spot.path} className="quality-list-row">
                        <button type="button" className="quality-file-btn" onClick={() => onOpenFile(spot.path)}>
                          <span className="quality-item-path">{spot.path}</span>
                          <small className="quality-item-detail">{spot.reason}</small>
                        </button>
                        <QualityAskMenuButton
                          label="Refatorar"
                          className="quality-refactor-btn"
                          title={`Refatorar ${spot.path}`}
                          ariaLabel={`Refatorar ponto crítico ${spot.path}`}
                          menuAriaLabel={`Escolher agente para ponto crítico ${spot.path}`}
                          terminals={terminals}
                          open={openMenuId === menuId}
                          onOpenChange={(next) => setOpenMenuId(next ? menuId : null)}
                          onSelectTerminal={(name) => void askAgent(name, { kind: 'refactor', target: { type: 'file', path: spot.path } })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {report.cycles.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Ciclos de import</h3>
                <ul className="quality-list">
                  {report.cycles.map((cycle, index) => {
                    const menuId = `cycle-${index}`;
                    const cycleLabel = cycle.files.join(' ↔ ');
                    return (
                      <li key={`${cycle.typeOnly ? 'type' : 'rt'}-${index}`} className="quality-cycle-item">
                        <div className="quality-cycle-head">
                          <span className={`quality-cycle-kind ${cycle.typeOnly ? 'is-warn' : 'is-bad'}`}>
                            {cycle.typeOnly ? 'Só tipos' : 'Em execução'}
                          </span>
                          <QualityAskMenuButton
                            label="Refatorar"
                            className="quality-refactor-btn"
                            title={`Refatorar ciclo ${cycleLabel}`}
                            ariaLabel={`Refatorar ciclo ${cycleLabel}`}
                            menuAriaLabel={`Escolher agente para ciclo ${cycleLabel}`}
                            terminals={terminals}
                            open={openMenuId === menuId}
                            onOpenChange={(next) => setOpenMenuId(next ? menuId : null)}
                            onSelectTerminal={(name) => void askAgent(name, { kind: 'refactor', target: { type: 'cycle', files: cycle.files } })}
                          />
                        </div>
                        <div className="quality-cycle-files">
                          {cycle.files.map((filePath) => (
                            <button key={filePath} type="button" className="quality-link-btn" onClick={() => onOpenFile(filePath)}>
                              {filePath}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {report.functions.length > 0 ? (
              <div className="quality-section">
                <h3 className="quality-section-title">Funções mais complexas</h3>
                <ul className="quality-list">
                  {report.functions.slice(0, 10).map((fn) => {
                    const menuId = `fn-${fn.path}:${fn.line}:${fn.name}`;
                    const fnLabel = `${fn.name} (${fn.path}:${fn.line})`;
                    return (
                      <li key={`${fn.path}:${fn.line}:${fn.name}`} className="quality-list-row">
                        <button type="button" className="quality-file-btn" onClick={() => onOpenFile(fn.path)}>
                          <span className="quality-item-path">{`${fn.name} (${fn.complexity})`}</span>
                          <small className="quality-item-detail">{`${fn.path}:${fn.line}`}</small>
                        </button>
                        <QualityAskMenuButton
                          label="Refatorar"
                          className="quality-refactor-btn"
                          title={`Refatorar ${fnLabel}`}
                          ariaLabel={`Refatorar função ${fnLabel}`}
                          menuAriaLabel={`Escolher agente para função ${fnLabel}`}
                          terminals={terminals}
                          open={openMenuId === menuId}
                          onOpenChange={(next) => setOpenMenuId(next ? menuId : null)}
                          onSelectTerminal={(name) =>
                            void askAgent(name, { kind: 'refactor', target: { type: 'function', path: fn.path, name: fn.name, line: fn.line } })
                          }
                        />
                      </li>
                    );
                  })}
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
