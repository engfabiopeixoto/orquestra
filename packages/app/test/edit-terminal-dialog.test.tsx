// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { EditTerminalDialog } from '../src/renderer/src/components/EditTerminalDialog';
import { appStore } from '../src/renderer/src/store';

// Antes dos imports: módulos da interface criam a ponte de comandos com window.orquestra ao carregar.
vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

const info = (overrides = {}) => ({ name: 'A', agent: 'claude', state: 'idle' as const, queued: 0, cwd: 'C:/p', resume: true, args: ['--append-system-prompt', 'fale em português'], regente: false, monitor: true, ...overrides });

function fakeApi(result: unknown = info()) {
  const calls: Array<[string, unknown]> = [];
  const api = { command: (async (method: string, params: unknown) => { calls.push([method, params]); return result; }) as CommandApi['command'] };
  return { api, calls };
}

beforeEach(() => {
  appStore.getState().loadProject({ dir: 'C:/p', name: 'p', terminals: [info(), info({ name: 'C', args: [] })], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } });
});
afterEach(cleanup);

describe('EditTerminalDialog', () => {
  it('edição mostra os argumentos atuais formatados', () => {
    const { api } = fakeApi();
    render(<EditTerminalDialog name="A" api={api} onClose={() => {}} />);
    expect((screen.getByTestId('edit-terminal-args') as HTMLInputElement).value).toBe('--append-system-prompt "fale em português"');
    expect(screen.getByText('Tipo: claude')).toBeTruthy();
  });

  it('salvar sem mudanças só fecha, sem chamar o núcleo', () => {
    const { api, calls } = fakeApi();
    const onClose = vi.fn();
    render(<EditTerminalDialog name="A" api={api} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(calls).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('envia só o que mudou e troca o nó pelo resultado', async () => {
    const { api, calls } = fakeApi(info({ name: 'B', args: ['--model', 'opus'] }));
    const onClose = vi.fn();
    render(<EditTerminalDialog name="A" api={api} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('edit-terminal-name'), { target: { value: 'B' } });
    fireEvent.change(screen.getByTestId('edit-terminal-args'), { target: { value: '--model opus' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([['terminal.update', { name: 'A', newName: 'B', args: ['--model', 'opus'] }]]);
    expect(appStore.getState().terminals.B).toMatchObject({ args: ['--model', 'opus'] });
  });

  it('terminal ocupado pede confirmação antes de relançar; recusar não envia', () => {
    appStore.getState().applyEvent({ type: 'terminal.state', name: 'A', state: 'busy', queued: 0 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { api, calls } = fakeApi();
    render(<EditTerminalDialog name="A" api={api} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('edit-terminal-args'), { target: { value: '--model opus' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/A está ocupado ou tem pedidos na fila. Salvar reinicia o agente/));
    expect(calls).toEqual([]);
    confirm.mockRestore();
  });

  it('argumento reservado, aspas abertas e nome repetido aparecem no diálogo, sem enviar', () => {
    const { api, calls } = fakeApi();
    render(<EditTerminalDialog name="A" api={api} onClose={() => {}} />);
    const args = screen.getByTestId('edit-terminal-args');
    fireEvent.change(args, { target: { value: '--resume' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(screen.getByTestId('edit-terminal-error').textContent).toMatch(/--resume é controlado pelo Orquestra/);
    fireEvent.change(args, { target: { value: '"aberta' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(screen.getByTestId('edit-terminal-error').textContent).toMatch(/Aspas sem fechamento/);
    fireEvent.change(args, { target: { value: '' } });
    fireEvent.change(screen.getByTestId('edit-terminal-name'), { target: { value: 'C' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(screen.getByTestId('edit-terminal-error').textContent).toMatch(/Já existe um terminal chamado C/);
    expect(calls).toEqual([]);
  });

  it('nome vazio mostra a mensagem do schema, sem enviar', () => {
    const { api, calls } = fakeApi();
    render(<EditTerminalDialog name="A" api={api} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('edit-terminal-name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(screen.getByTestId('edit-terminal-error').textContent).toBe('Nome inválido: o nome não pode ficar vazio. Escolha outro nome.');
    expect(calls).toEqual([]);
  });

  it('erro do núcleo aparece no diálogo e mantém os campos', async () => {
    const api = { command: (async () => { throw new Error('A pasta X não existe. Crie a pasta ou escolha outra.'); }) as CommandApi['command'] };
    render(<EditTerminalDialog name="A" api={api} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('edit-terminal-cwd'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    expect(await screen.findByText(/A pasta X não existe/)).toBeTruthy();
    expect((screen.getByTestId('edit-terminal-cwd') as HTMLInputElement).value).toBe('X');
  });

  it('marcar regente envia terminal.update com regente: true', async () => {
    const { api, calls } = fakeApi();
    const onClose = vi.fn();
    render(<EditTerminalDialog name="A" api={api} onClose={onClose} />);
    const regenteCheckbox = screen.getByTestId('edit-terminal-regente');
    expect((regenteCheckbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(regenteCheckbox);
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([['terminal.update', { name: 'A', regente: true }]]);
  });

  it('desmarcar monitorar envia terminal.update com monitor: false', async () => {
    const { api, calls } = fakeApi();
    const onClose = vi.fn();
    render(<EditTerminalDialog name="A" api={api} onClose={onClose} />);
    const monitorCheckbox = screen.getByTestId('edit-terminal-monitor');
    expect((monitorCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(monitorCheckbox);
    fireEvent.click(screen.getByTestId('edit-terminal-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([['terminal.update', { name: 'A', monitor: false }]]);
  });
});

