import { personaSchema, type PersonaScope } from '@orquestra/shared/regent';
import { useCallback, useEffect, useState } from 'react';
import type { CommandApi } from '../api';

export function PersonasDialog({
  api,
  hasProject,
  onClose,
}: {
  api: CommandApi;
  hasProject: boolean;
  onClose(): void;
}) {
  const [list, setList] = useState<Array<{ name: string; text: string; scope: PersonaScope }>>([]);
  const [editing, setEditing] = useState<{
    name: string;
    text: string;
    scope: PersonaScope;
    isNew: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.command('persona.list', {});
      setList(result.personas);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!editing) return;
    const parsed = personaSchema.safeParse({ name: editing.name.trim(), text: editing.text });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(issue?.path[0] === 'name' ? `Nome inválido: ${issue.message}. Escolha outro nome.` : (issue?.message ?? 'confira a função'));
    }

    try {
      await api.command('persona.save', {
        name: editing.name.trim(),
        text: editing.text,
        scope: editing.scope,
      });
      setError(null);
      setEditing(null);
      await load();
    } catch (saveError) {
      setError((saveError as Error).message);
    }
  };

  const remove = async (persona: { name: string; scope: PersonaScope }) => {
    if (!window.confirm(`Apagar a função ${persona.name}?`)) return;
    try {
      await api.command('persona.remove', { name: persona.name, scope: persona.scope });
      if (editing?.name === persona.name) setEditing(null);
      setError(null);
      await load();
    } catch (removeError) {
      setError((removeError as Error).message);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-label="Funções">
      {editing ? (
        <form
          className="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>{editing.isNew ? 'Nova função' : `Editar função: ${editing.name}`}</h2>
          <label>
            Nome
            <input
              data-testid="personas-name"
              value={editing.name}
              disabled={!editing.isNew}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </label>
          <label>
            Texto
            <textarea
              data-testid="personas-text"
              rows={5}
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            />
          </label>
          <label>
            Escopo
            <select
              data-testid="personas-scope"
              value={editing.scope}
              onChange={(event) => setEditing({ ...editing, scope: event.target.value as PersonaScope })}
            >
              <option value="project" disabled={!hasProject}>
                Projeto
              </option>
              <option value="global">Global</option>
            </select>
          </label>
          {error ? <p className="dialog-error" data-testid="personas-error">{error}</p> : null}
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
            >
              Cancelar
            </button>
            <button type="submit" className="primary" data-testid="personas-save">
              Salvar
            </button>
          </div>
        </form>
      ) : (
        <div className="dialog">
          <h2>Funções</h2>
          <p className="muted">Funções definem instruções para agentes do projeto ou globais.</p>
          <button
            type="button"
            className="primary"
            data-testid="personas-new"
            onClick={() => {
              setEditing({
                name: '',
                text: '',
                scope: hasProject ? 'project' : 'global',
                isNew: true,
              });
              setError(null);
            }}
          >
            Nova função
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {list.map((item) => (
              <div
                key={`${item.scope}:${item.name}`}
                data-testid={`personas-item-${item.name}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setEditing({
                    name: item.name,
                    text: item.text,
                    scope: item.scope,
                    isNew: false,
                  });
                  setError(null);
                }}
              >
                <div>
                  <strong>{item.name}</strong>{' '}
                  <span className="muted">({item.scope === 'project' ? 'projeto' : 'global'})</span>
                </div>
                <button
                  type="button"
                  data-testid={`personas-remove-${item.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void remove(item);
                  }}
                >
                  Apagar
                </button>
              </div>
            ))}
          </div>
          {error ? <p className="dialog-error" data-testid="personas-error">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
