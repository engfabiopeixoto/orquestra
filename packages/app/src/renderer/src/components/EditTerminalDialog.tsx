import { formatArgs, parseArgs, reservedArgError } from '@orquestra/shared/args';
import { terminalNameSchema } from '@orquestra/shared/host-protocol';
import { useState } from 'react';
import type { CommandApi } from '../api';
import { appStore, useApp } from '../store';
import { ArgsField } from './ArgsField';

const sameArgs = (a: string[], b: string[]) => a.length === b.length && a.every((arg, index) => arg === b[index]);

export function EditTerminalDialog({ name, api, onClose }: { name: string; api: CommandApi; onClose(): void }) {
  const view = useApp((state) => state.terminals[name]);
  const [newName, setNewName] = useState(name);
  const [cwd, setCwd] = useState(view?.cwd ?? '');
  const [argsText, setArgsText] = useState(formatArgs(view?.args ?? []));
  const [resume, setResume] = useState(view?.resume ?? true);
  const [regente, setRegente] = useState(view?.regente ?? false);
  const [monitor, setMonitor] = useState(view?.monitor ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  if (!view) return null;

  const submit = async () => {
    if (submitting) return;
    const trimmed = newName.trim();
    const parsedName = terminalNameSchema.safeParse(trimmed);
    if (!parsedName.success) return setError(`Nome inválido: ${parsedName.error.issues[0]?.message ?? 'confira o nome'}. Escolha outro nome.`);
    if (trimmed !== name && appStore.getState().terminals[trimmed]) return setError(`Já existe um terminal chamado ${trimmed}. Escolha outro nome.`);
    let args: string[];
    try {
      args = parseArgs(argsText);
    } catch (parseError) {
      return setError((parseError as Error).message);
    }
    const reserved = reservedArgError(view.agent, args);
    if (reserved) return setError(reserved);

    const changes: { newName?: string; cwd?: string; args?: string[]; resume?: boolean; regente?: boolean; monitor?: boolean } = {};
    if (trimmed !== name) changes.newName = trimmed;
    if (cwd !== view.cwd) changes.cwd = cwd;
    if (!sameArgs(args, view.args)) changes.args = args;
    if (view.agent !== 'shell' && resume !== view.resume) changes.resume = resume;
    if (regente !== view.regente) changes.regente = regente;
    if (monitor !== view.monitor) changes.monitor = monitor;
    if (Object.keys(changes).length === 0) return onClose();
    const relaunch = changes.cwd !== undefined || changes.args !== undefined;
    const busy = view.state === 'busy' || view.queued > 0;
    if (relaunch && busy && !window.confirm(`${name} está ocupado ou tem pedidos na fila. Salvar reinicia o agente e interrompe o trabalho. Continuar?`)) return;

    setError(null);
    setSubmitting(true);
    try {
      appStore.getState().replaceTerminal(name, await api.command('terminal.update', { name, ...changes }));
      onClose();
    } catch (updateError) {
      setError((updateError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-label="Editar terminal">
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Editar terminal</h2>
        <p className="muted">Tipo: {view.agent}</p>
        <label>
          Nome
          <input data-testid="edit-terminal-name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={submitting} autoFocus />
        </label>
        <label>
          Pasta
          <input data-testid="edit-terminal-cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={submitting} />
        </label>
        <label>
          Argumentos
          <ArgsField agent={view.agent} value={argsText} onChange={setArgsText} testId="edit-terminal-args" disabled={submitting} />
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="edit-terminal-resume"
            checked={resume && view.agent !== 'shell'}
            disabled={submitting || view.agent === 'shell'}
            onChange={(event) => setResume(event.target.checked)}
          />
          Retomar a sessão ao reabrir o projeto
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="edit-terminal-regente"
            checked={regente}
            disabled={submitting}
            onChange={(event) => setRegente(event.target.checked)}
          />
          Regente
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="edit-terminal-monitor"
            checked={monitor}
            disabled={submitting}
            onChange={(event) => setMonitor(event.target.checked)}
          />
          Monitorar atividade
        </label>
        {error ? <p className="dialog-error" data-testid="edit-terminal-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>Cancelar</button>
          <button type="submit" className="primary" data-testid="edit-terminal-submit" disabled={submitting}>Salvar</button>
        </div>
      </form>
    </div>
  );
}
