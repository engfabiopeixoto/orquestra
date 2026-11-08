import { AGENT_MODELS, isModelAgent, modelNameSchema, type TerminalModel } from '@orquestra/shared/models';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandApi } from '../api';
import { appStore } from '../store';

const MENU_WIDTH = 240;

/** Texto, dica e alerta da tag a partir do modelo escolhido e do modelo que o agente informou. */
export function modelTagView(model: TerminalModel | undefined): { label: string; title: string; alert: boolean } {
  const chosen = model?.chosen ?? null;
  const effective = model?.effective ?? null;
  if (!model || chosen === null) {
    return effective
      ? { label: effective, title: `O agente está usando ${effective}. Clique para escolher o modelo.`, alert: false }
      : { label: 'modelo', title: 'Modelo ainda não detectado. Clique para escolher o modelo.', alert: false };
  }
  switch (model.status) {
    case 'mismatch':
      return { label: chosen, title: `O agente está usando ${effective}, a tag diz ${chosen}.`, alert: true };
    case 'match':
      return { label: chosen, title: `O agente confirmou o modelo ${effective}.`, alert: false };
    case 'pending':
      return { label: chosen, title: `Modelo escolhido: ${chosen}. O agente confirma o modelo no próximo turno.`, alert: false };
    default:
      return { label: chosen, title: `Modelo escolhido: ${chosen}. O modelo em uso ainda não foi detectado.`, alert: false };
  }
}

export function ModelTag({ name, agent, model, api }: { name: string; agent: string; model: TerminalModel | undefined; api: CommandApi }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [menu]);
  if (!isModelAgent(agent)) return null;
  const view = modelTagView(model);

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setError(null);
    if (menu) return setMenu(null);
    // Fora do card (overflow: hidden) e na escala da tela, como o menu de opções do terminal.
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)), y: rect.bottom + 4 });
  };

  const choose = async (value: string) => {
    const parsed = modelNameSchema.safeParse(value);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Modelo inválido.');
    setSending(true);
    try {
      const info = await api.command('terminal.model', { name, model: parsed.data });
      const terminal = appStore.getState().terminals[name];
      // Sem replaceTerminal: ele remonta o corpo do terminal, e trocar o modelo não reinicia o agente.
      if (terminal && info.model) appStore.setState({ terminals: { ...appStore.getState().terminals, [name]: { ...terminal, model: info.model } } });
      setMenu(null);
      setCustom('');
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={`chip model-tag nodrag nopan${view.alert ? ' is-mismatch' : ''}`}
        data-testid={`terminal-model-${name}`}
        title={view.title}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggle}
      >
        {view.alert ? '⚠ ' : ''}{view.label}
      </button>
      {menu ? createPortal(
        <div
          ref={menuRef}
          className="model-menu nodrag nopan"
          role="menu"
          aria-label={`Modelo de ${name}`}
          data-testid={`terminal-model-menu-${name}`}
          style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {AGENT_MODELS[agent].map((option) => (
            <button key={option.id} role="menuitemradio" aria-checked={model?.chosen === option.id} disabled={sending} title={option.id} onClick={() => void choose(option.id)}>
              {option.label}
            </button>
          ))}
          <form onSubmit={(event) => { event.preventDefault(); void choose(custom); }}>
            <input aria-label="Outro modelo" placeholder="outro modelo" value={custom} disabled={sending} onChange={(event) => setCustom(event.target.value)} />
            <button type="submit" disabled={sending || custom.trim() === ''}>Usar</button>
          </form>
          {error ? <p className="model-error" role="alert">{error}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
