// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AGENT_MODELS, type TerminalModel } from '@orquestra/shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { appStore } from '../src/renderer/src/store';
import { ModelTag, modelTagView } from '../src/renderer/src/terminal/ModelTag';

// Antes dos imports: módulos da interface criam a ponte de comandos com window.orquestra ao carregar.
vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

const info = (overrides = {}) => ({ name: 'A', agent: 'claude', state: 'idle' as const, queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: true, ...overrides });

function fakeApi(result: unknown, fail?: string) {
  const calls: Array<[string, unknown]> = [];
  const api = {
    command: (async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (fail) throw new Error(fail);
      return result;
    }) as CommandApi['command'],
  };
  return { api, calls };
}

beforeEach(() => {
  appStore.getState().loadProject({ dir: 'C:/p', name: 'p', terminals: [info()], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } });
});
afterEach(cleanup);

describe('texto da tag de modelo', () => {
  it('sem escolha mostra o modelo efetivo, ou "modelo" se desconhecido, sem alerta', () => {
    expect(modelTagView(undefined)).toMatchObject({ label: 'modelo', alert: false });
    expect(modelTagView({ chosen: null, effective: 'gpt-6.1-sol', status: 'unset' })).toMatchObject({ label: 'gpt-6.1-sol', alert: false });
  });

  it('só a divergência confirmada acende o alerta, com o modelo em uso e o da tag', () => {
    expect(modelTagView({ chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'mismatch' })).toEqual({
      label: 'opus',
      title: 'O agente está usando claude-sonnet-5-5, a tag diz opus.',
      alert: true,
    });
    for (const status of ['match', 'pending', 'unknown'] as const) {
      expect(modelTagView({ chosen: 'opus', effective: 'claude-sonnet-5-5', status }).alert).toBe(false);
    }
  });
});

describe('ModelTag', () => {
  const mismatch: TerminalModel = { chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'mismatch' };

  it('divergência deixa a tag vermelha com a explicação no title', () => {
    render(<ModelTag name="A" agent="claude" model={mismatch} api={fakeApi(null).api} />);
    const tag = screen.getByTestId('terminal-model-A');
    expect(tag.className).toContain('is-mismatch');
    expect(tag.getAttribute('title')).toBe('O agente está usando claude-sonnet-5-5, a tag diz opus.');
  });

  it('o shell não tem tag', () => {
    render(<ModelTag name="S" agent="shell" model={undefined} api={fakeApi(null).api} />);
    expect(screen.queryByTestId('terminal-model-S')).toBeNull();
  });

  it('clicar abre a lista fixa do agente e escolher um modelo pede a troca ao núcleo', async () => {
    const model: TerminalModel = { chosen: 'gpt-6-luna', effective: null, status: 'unknown' };
    const { api, calls } = fakeApi(info({ agent: 'codex', model }));
    render(<ModelTag name="A" agent="codex" model={undefined} api={api} />);
    fireEvent.click(screen.getByTestId('terminal-model-A'));
    const menu = screen.getByTestId('terminal-model-menu-A');
    expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((item) => item.getAttribute('title'))).toEqual(AGENT_MODELS.codex.map((option) => option.id));
    fireEvent.click(screen.getByText('GPT-6-Luna'));
    await waitFor(() => expect(screen.queryByTestId('terminal-model-menu-A')).toBeNull());
    expect(calls).toEqual([['terminal.model', { name: 'A', model: 'gpt-6-luna' }]]);
    // Atualiza só o modelo: o corpo do terminal não remonta (o agente não reinicia).
    expect(appStore.getState().terminals.A).toMatchObject({ model, epoch: 0 });
  });

  it('aceita outro nome digitado e valida antes de enviar', async () => {
    const { api, calls } = fakeApi(info({ model: { chosen: 'opus[1m]', effective: null, status: 'unknown' } }));
    render(<ModelTag name="A" agent="claude" model={mismatch} api={api} />);
    fireEvent.click(screen.getByTestId('terminal-model-A'));
    fireEvent.change(screen.getByLabelText('Outro modelo'), { target: { value: 'opus 1m' } });
    fireEvent.click(screen.getByText('Usar'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/letras, números/);
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByLabelText('Outro modelo'), { target: { value: 'opus[1m]' } });
    fireEvent.click(screen.getByText('Usar'));
    await waitFor(() => expect(calls).toEqual([['terminal.model', { name: 'A', model: 'opus[1m]' }]]));
  });

  it('erro do núcleo (agente ocupado) aparece no menu, que continua aberto', async () => {
    const { api } = fakeApi(null, 'A não está ocioso (busy). Espere o fim do turno e tente de novo.');
    render(<ModelTag name="A" agent="claude" model={undefined} api={api} />);
    fireEvent.click(screen.getByTestId('terminal-model-A'));
    fireEvent.click(screen.getByText('Sonnet (mais recente)'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/não está ocioso/);
    expect(screen.getByTestId('terminal-model-menu-A')).toBeTruthy();
  });

  it('o evento terminal.model do núcleo atualiza a tag no store', () => {
    appStore.getState().applyEvent({ type: 'terminal.model', name: 'A', model: mismatch });
    expect(appStore.getState().terminals.A?.model).toEqual(mismatch);
  });
});
