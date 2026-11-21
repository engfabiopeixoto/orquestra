import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QualityReport, QualitySignal } from '@orquestra/shared/quality-schema';
import type { CommandApi } from '../api';
import { QUALITY_SHORTCUT_HINT } from '../canvas/shortcuts';
import {
  clampQualityWidth,
  QUALITY_DEFAULT_WIDTH,
  QUALITY_MAX_WIDTH_RATIO,
  QUALITY_MIN_WIDTH,
  readQualityDrawerPrefs,
  writeQualityDrawerPrefs,
} from '../layout-prefs';
import { usePortalOverlay } from '../portal/modal-overlay';
import type { QualityAgentTerminal } from './QualityAskMenuButton';
import { QualityPanel } from './QualityPanel';
import { SplitHandle } from './SplitHandle';

function worstQualitySignal(report: QualityReport | null): Exclude<QualitySignal, 'missing'> | null {
  if (!report || report.language !== 'js-ts') return null;
  if (report.metrics.some((metric) => metric.signal === 'bad')) return 'bad';
  if (report.metrics.some((metric) => metric.signal === 'warn')) return 'warn';
  if (report.metrics.some((metric) => metric.signal === 'ok')) return 'ok';
  return null;
}

const SIGNAL_ARIA: Record<Exclude<QualitySignal, 'missing'>, string> = {
  ok: 'OK',
  warn: 'Atenção',
  bad: 'Problema',
};

/** Painel retrátil de Qualidade fixado à direita do canvas (o canvas encolhe ao lado dele). */
export function QualityDrawer({
  api,
  projectDir,
  workspaceKey,
  terminals,
  open: controlledOpen,
  toggleSignal = 0,
  onToggle,
  onOpenFile,
}: {
  api: CommandApi;
  projectDir: string;
  workspaceKey: string;
  terminals: QualityAgentTerminal[];
  open?: boolean;
  toggleSignal?: number;
  onToggle?(): void;
  onOpenFile(path: string): void;
}) {
  const [prefs, setPrefs] = useState(() => readQualityDrawerPrefs(workspaceKey));
  const [report, setReport] = useState<QualityReport | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 1280);
  const [draggingWidth, setDraggingWidth] = useState(false);
  const initialToggleRef = useRef(toggleSignal);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  usePortalOverlay(draggingWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const open = controlledOpen !== undefined ? controlledOpen : prefs.open;

  // Quando o painel está recolhido, busca a última medição para atualizar o ponto de sinal da faixa.
  useEffect(() => {
    if (open) return;
    let active = true;
    void api
      .command('quality.read', {})
      .then((res) => {
        if (active) setReport(res.report);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, projectDir, open]);

  const toggle = useCallback(() => {
    if (onToggleRef.current) {
      onToggleRef.current();
      return;
    }
    setPrefs((current) => {
      const next = { ...current, open: !current.open };
      writeQualityDrawerPrefs(workspaceKey, next);
      return next;
    });
  }, [workspaceKey]);

  const headerAction = useMemo(
    () => (
      <button
        type="button"
        className="quality-collapse-btn"
        data-testid="quality-drawer-collapse"
        aria-label="Recolher painel de Qualidade"
        title={`Recolher Qualidade (${QUALITY_SHORTCUT_HINT})`}
        onClick={toggle}
      >
        »
      </button>
    ),
    [toggle],
  );

  useEffect(() => {
    if (toggleSignal === initialToggleRef.current) return;
    initialToggleRef.current = toggleSignal;
    toggle();
  }, [toggleSignal]);

  const signal = worstQualitySignal(report);
  const signalText = signal ? SIGNAL_ARIA[signal] : 'Sem medição';
  const maxWidth = Math.max(QUALITY_MIN_WIDTH, Math.floor(viewportWidth * QUALITY_MAX_WIDTH_RATIO));
  const width = clampQualityWidth(prefs.width, viewportWidth);

  const commitWidth = (nextWidth: number) => {
    const clamped = clampQualityWidth(nextWidth, viewportWidth);
    setPrefs((current) => {
      const next = { open: controlledOpen !== undefined ? controlledOpen : current.open, width: clamped };
      writeQualityDrawerPrefs(workspaceKey, next);
      return next;
    });
  };

  if (!open) {
    return (
      <aside className="quality-drawer is-collapsed" data-testid="quality-drawer">
        <button
          type="button"
          className="quality-strip"
          data-testid="quality-drawer-toggle"
          aria-expanded={false}
          aria-label={`Abrir painel de Qualidade (${signalText}) — ${QUALITY_SHORTCUT_HINT}`}
          title={`Abrir Qualidade (${signalText}) (${QUALITY_SHORTCUT_HINT})`}
          onClick={toggle}
        >
          <span className={`quality-signal-dot is-${signal ?? 'missing'}`} aria-hidden="true" />
          <span className="quality-strip-label">Qualidade</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="quality-drawer is-open" data-testid="quality-drawer" style={{ width }}>
      <SplitHandle
        orientation="vertical"
        reverse
        ariaLabel="Ajustar largura do painel de Qualidade"
        value={width}
        min={QUALITY_MIN_WIDTH}
        max={maxWidth}
        testId="quality-resizer"
        title="Arraste ou dê duplo clique para restaurar a largura padrão"
        onDraggingChange={setDraggingWidth}
        onChange={(nextWidth) => {
          const clamped = clampQualityWidth(nextWidth, viewportWidth);
          setPrefs((current) => ({ ...current, width: clamped }));
        }}
        onCommit={commitWidth}
        onReset={() => commitWidth(QUALITY_DEFAULT_WIDTH)}
      />
      <div className="quality-drawer-body">
        <QualityPanel
          key={workspaceKey}
          api={api}
          projectDir={projectDir}
          terminals={terminals}
          onReportChange={setReport}
          onOpenFile={onOpenFile}
          headerAction={headerAction}
        />
      </div>
    </aside>
  );
}
