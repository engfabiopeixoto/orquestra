import { canvasMotionSchema, formatArgs, parseArgs, reservedArgError, type CanvasMotion, type Settings } from '@orquestra/shared/args';
import { useEffect, useState } from 'react';
import type { CommandApi } from '../api';
import { ArgsField } from './ArgsField';

const AGENTS = ['claude', 'agy', 'codex'] as const;

export function SettingsDialog({ api, onClose, onCanvasChange }: { api: CommandApi; onClose(): void; onCanvasChange?(canvas: Settings['canvas']): void }) {
  const [texts, setTexts] = useState<Record<(typeof AGENTS)[number], string> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [motion, setMotion] = useState<CanvasMotion>('contained');
  const [error, setError] = useState<string | null>(null);

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
  }, [api]);

  if (!texts) return null;

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
        className="dialog"
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
        {error ? <p className="dialog-error" data-testid="settings-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" data-testid="settings-submit">Salvar</button>
        </div>
      </form>
    </div>
  );
}
