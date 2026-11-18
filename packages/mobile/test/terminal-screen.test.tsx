// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalInfo } from '@orquestra/shared/host-protocol';
import { TerminalScreen, type OutputBus, type OutputSignal } from '../src/TerminalScreen';
import { fontSizeForWidth, readXtermBufferText, type TerminalView } from '../src/terminal-view';
import type { ConnectionStatus, RemoteWsClient } from '../src/ws-client';

const term = (extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  name: 'revisor', agent: 'claude', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false, ...extra,
});

function setup(opts: { terminal?: TerminalInfo; status?: ConnectionStatus; commands?: Record<string, (params: any) => unknown> } = {}) {
  const listeners = new Set<(signal: OutputSignal) => void>();
  const bus: OutputBus = { subscribe: (l) => { listeners.add(l); return () => void listeners.delete(l); } };
  const emit = (signal: OutputSignal) => act(() => listeners.forEach((l) => l(signal)));
  const updateListeners = new Set<(immediate?: boolean) => void>();
  let bufferText = '';
  const view = {
    load: vi.fn((data: string) => {
      bufferText = data.replace(/\n+$/, '');
      for (const l of updateListeners) l(true);
    }),
    write: vi.fn((data: string) => {
      bufferText += data;
      for (const l of updateListeners) l(false);
    }),
    readText: vi.fn(() => bufferText.replace(/\n+$/, '')),
    fitWidth: vi.fn(() => false),
    onUpdate: vi.fn((listener: (immediate?: boolean) => void) => {
      updateListeners.add(listener);
      return () => void updateListeners.delete(listener);
    }),
    dispose: vi.fn(),
  } satisfies TerminalView;
  const handlers: Record<string, (params: any) => unknown> = {
    'terminal.snapshot': () => ({ data: 'retrato', cols: 100, rows: 30 }),
    'models.catalog': () => ({ claude: { models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] } }),
    ...opts.commands,
  };
  const client = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    command: vi.fn(async (method: string, params: any) => (handlers[method] ? handlers[method]!(params) : {})),
  };
  const onBack = vi.fn();
  const createView = () => view;
  const ui = (status: ConnectionStatus, terminal: TerminalInfo) => (
    <TerminalScreen client={client as unknown as RemoteWsClient} workspaceId="w1" terminal={terminal} status={status} bus={bus} onBack={onBack} createView={createView} />
  );
  const utils = render(ui(opts.status ?? 'connected', opts.terminal ?? term()));
  return { ...utils, client, view, emit, onBack, rerenderWith: (status: ConnectionStatus, terminal = opts.terminal ?? term()) => utils.rerender(ui(status, terminal)) };
}
const calls = (client: { command: ReturnType<typeof vi.fn> }, method: string) => client.command.mock.calls.filter((c) => c[0] === method);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('fontSizeForWidth', () => {
  it('encolhe a letra para caber as colunas do PC e só rola na horizontal quando não couber', () => {
    expect(fontSizeForWidth(390, 50)).toEqual({ fontSize: 13, scrollsHorizontally: false });
    expect(fontSizeForWidth(390, 70)).toEqual({ fontSize: 9, scrollsHorizontally: false });
    expect(fontSizeForWidth(390, 120)).toEqual({ fontSize: 9, scrollsHorizontally: true });
    expect(fontSizeForWidth(2000, 40).fontSize).toBe(14);
    expect(fontSizeForWidth(0, 80).scrollsHorizontally).toBe(false);
  });
});

describe('TerminalScreen', () => {
  it('assina a saída, carrega o retrato no tamanho do PC e escreve só a saída posterior', async () => {
    const { client, view, emit } = setup();
    await waitFor(() => expect(view.load).toHaveBeenCalledWith('retrato', 100, 30, expect.any(Number)));
    expect(client.subscribe).toHaveBeenCalledWith('w1', 'revisor');
    expect(calls(client, 'terminal.snapshot')[0]).toEqual(['terminal.snapshot', { name: 'revisor' }, 'w1']);
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: 'ao-vivo', workspaceId: 'w1' } });
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'outro', data: 'de-outro', workspaceId: 'w1' } });
    expect(view.write.mock.calls).toEqual([['ao-vivo']]);
  });

  it('descarta saída que chega antes do retrato e cancela a assinatura ao sair', async () => {
    let release!: (value: unknown) => void;
    const { view, emit, client, unmount } = setup({ commands: { 'terminal.snapshot': () => new Promise((resolve) => { release = resolve; }) } });
    await waitFor(() => expect(client.command).toHaveBeenCalled());
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: 'cedo', workspaceId: 'w1' } });
    expect(view.write).not.toHaveBeenCalled();
    await act(async () => release({ data: 'r', cols: 80, rows: 24 }));
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: 'tarde', workspaceId: 'w1' } });
    expect(view.write.mock.calls).toEqual([['tarde']]);
    unmount();
    expect(client.unsubscribe).toHaveBeenCalledWith('w1', 'revisor');
    expect(view.dispose).toHaveBeenCalled();
  });

  it('mostra o estado do agente no topo e volta para a lista de agentes', () => {
    const { onBack } = setup({ terminal: term({ state: 'waiting' }) });
    expect(screen.getByTestId('terminal-state').textContent).toBe('Esperando você');
    const backBtn = screen.getByTestId('terminal-back');
    expect(backBtn.getAttribute('aria-label')).toBe('Voltar aos agentes');
    expect(backBtn.textContent).toBe('←');
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalled();
  });

  it('envia a mensagem pelo campo (terminal.send), limpa o campo e mostra erro se falhar', async () => {
    const { client } = setup();
    const input = screen.getByLabelText('Mensagem para revisor') as HTMLTextAreaElement;
    expect((screen.getByTestId('send-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  revise o PR 12  ' } });
    fireEvent.click(screen.getByTestId('send-submit'));
    await waitFor(() => expect(calls(client, 'terminal.send')).toEqual([['terminal.send', { name: 'revisor', text: 'revise o PR 12' }, 'w1']]));
    await waitFor(() => expect(input.value).toBe(''));

    client.command.mockRejectedValueOnce(new Error('Recarregue o terminal revisor para interagir.'));
    fireEvent.change(input, { target: { value: 'de novo' } });
    fireEvent.click(screen.getByTestId('send-submit'));
    expect((await screen.findByTestId('terminal-error')).textContent).toContain('Recarregue');
    expect(input.value).toBe('de novo');
  });

  it('Enter sem Shift na textarea envia a mensagem; Shift+Enter mantém a quebra de linha sem enviar', async () => {
    const { client } = setup();
    const input = screen.getByLabelText('Mensagem para revisor') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'linha 1' } });

    const shiftEnterPrevented = !fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(shiftEnterPrevented).toBe(false);
    expect(calls(client, 'terminal.send')).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'linha 1\nlinha 2' } });
    const enterPrevented = !fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(enterPrevented).toBe(true);
    await waitFor(() =>
      expect(calls(client, 'terminal.send')).toEqual([['terminal.send', { name: 'revisor', text: 'linha 1\nlinha 2' }, 'w1']]),
    );
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('a barra de teclas envia cada tecla nomeada (terminal.key)', async () => {
    const { client } = setup();
    const expected: Record<string, string> = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', CtrlC: 'CtrlC', Digit1: 'Digit1', Digit2: 'Digit2', Digit3: 'Digit3' };
    for (const key of Object.keys(expected)) fireEvent.click(screen.getByTestId(`key-${key}`));
    await waitFor(() => expect(calls(client, 'terminal.key')).toHaveLength(9));
    expect(calls(client, 'terminal.key').map((c) => c[1].key)).toEqual(Object.values(expected));
    expect(calls(client, 'terminal.key')[0]).toEqual(['terminal.key', { name: 'revisor', key: 'Enter' }, 'w1']);
  });

  it('teclas e envio ficam desligados sem conexão ou com o terminal descarregado', () => {
    const offline = setup({ status: 'reconnecting' });
    expect((screen.getByTestId('key-Enter') as HTMLButtonElement).disabled).toBe(true);
    offline.unmount();
    setup({ terminal: term({ unloaded: true, state: 'exited' }) });
    expect((screen.getByTestId('key-Enter') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('send-input') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId('terminal-state').textContent).toBe('Descarregado');
  });

  it('Reiniciar exige confirmação: cancelar não faz nada e confirmar reinicia e recarrega o retrato', async () => {
    const { client } = setup();
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('terminal-menu'));
    fireEvent.click(screen.getByText('Reiniciar'));
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('Reiniciar revisor?');
    fireEvent.click(screen.getByText('Cancelar'));
    expect(calls(client, 'terminal.restart')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('terminal-menu'));
    fireEvent.click(screen.getByText('Reiniciar'));
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(calls(client, 'terminal.restart')).toEqual([['terminal.restart', { name: 'revisor' }, 'w1']]));
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(2));
  });

  it('Descarregar pede confirmação; terminal descarregado oferece Recarregar (terminal.restart)', async () => {
    const live = setup();
    fireEvent.click(screen.getByTestId('terminal-menu'));
    fireEvent.click(screen.getByText('Descarregar'));
    expect(calls(live.client, 'terminal.unload')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(calls(live.client, 'terminal.unload')).toHaveLength(1));
    live.unmount();

    const unloaded = setup({ terminal: term({ unloaded: true, state: 'exited' }) });
    fireEvent.click(screen.getByTestId('terminal-menu'));
    expect(screen.queryByText('Descarregar')).toBeNull();
    fireEvent.click(screen.getByText('Recarregar'));
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('Recarregar revisor?');
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(calls(unloaded.client, 'terminal.restart')).toHaveLength(1));
  });

  it('Trocar modelo lista o catálogo do agente, marca o modelo em uso (✓), rola até ele e só troca depois da confirmação', async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    const { client } = setup({
      terminal: term({ model: { chosen: 'sonnet', effective: 'claude-sonnet-5-5-20261101', status: 'match' } }),
      commands: {
        'models.catalog': () => ({
          claude: {
            models: [
              { id: 'fable', label: 'Fable' },
              { id: 'opus', label: 'Opus' },
              { id: 'sonnet', label: 'Sonnet' },
            ],
          },
        }),
      },
    });
    fireEvent.click(screen.getByTestId('terminal-menu'));
    fireEvent.click(screen.getByText('Trocar modelo'));
    expect(await screen.findByTestId('model-dialog')).toBeTruthy();

    const currentBtn = screen.getByTestId('model-option-sonnet');
    expect(currentBtn.getAttribute('aria-current')).toBe('true');
    expect(currentBtn.className).toContain('is-current');
    expect(currentBtn.textContent).toContain('✓');
    expect(screen.getByTestId('model-option-opus').getAttribute('aria-current')).toBeNull();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'center' });

    fireEvent.click(currentBtn);
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('Trocar o modelo de revisor para sonnet?');
    expect(calls(client, 'terminal.model')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(calls(client, 'terminal.model')).toEqual([['terminal.model', { name: 'revisor', model: 'sonnet' }, 'w1']]));
  });

  it('shell não tem modelo para trocar', () => {
    setup({ terminal: term({ agent: 'shell' }) });
    fireEvent.click(screen.getByTestId('terminal-menu'));
    expect((screen.getByText('Trocar modelo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('output-overflow pede um snapshot novo e volta a escrever a saída depois dele', async () => {
    const { client, view, emit } = setup();
    await waitFor(() => expect(view.load).toHaveBeenCalledTimes(1));
    emit({ kind: 'overflow', name: 'revisor' });
    expect(screen.getByTestId('terminal-notice').textContent).toContain('atualizando');
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(2));
    await waitFor(() => expect(view.load).toHaveBeenCalledTimes(2));
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: 'retomou', workspaceId: 'w1' } });
    expect(view.write).toHaveBeenCalledWith('retomou');
    emit({ kind: 'overflow', name: 'outro' });
    expect(calls(client, 'terminal.snapshot')).toHaveLength(2);
  });

  it('ao reconectar busca o retrato de novo', async () => {
    const { client, rerenderWith } = setup();
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(1));
    rerenderWith('reconnecting');
    expect(screen.getByText(/Sem conexão/)).toBeTruthy();
    rerenderWith('connected');
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(2));
  });

  it('um terminal reiniciado no PC (id novo) recarrega o retrato', async () => {
    const { client, rerenderWith } = setup({ terminal: term({ id: '11111111-1111-4111-8111-111111111111' }) });
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(1));
    rerenderWith('connected', term({ id: '22222222-2222-4222-8222-222222222222' }));
    await waitFor(() => expect(calls(client, 'terminal.snapshot')).toHaveLength(2));
  });

  it('abre no modo Leitura por padrão, atualiza o texto com throttle, alterna para Terminal salvando no localStorage e mostra "↓ Ir ao fim" ao rolar para cima', async () => {
    const { emit } = setup({
      commands: { 'terminal.snapshot': () => ({ data: 'linha 1\nlinha 2\n\n\n', cols: 100, rows: 30 }) },
    });

    const reading = await screen.findByTestId('terminal-reading');
    await waitFor(() => expect(reading.textContent).toBe('linha 1\nlinha 2'));
    expect(screen.getByTestId('terminal-host').hidden).toBe(true);

    // Saída ao vivo atualiza o texto do modo Leitura (com throttle ~100 ms)
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: '\nlinha 3', workspaceId: 'w1' } });
    await waitFor(() => expect(reading.textContent).toBe('linha 1\nlinha 2\nlinha 3'));

    // Rolar para cima exibe "↓ Ir ao fim"; clicar volta ao fim e esconde o botão
    Object.defineProperty(reading, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(reading, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(reading, 'scrollTop', { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(reading);
    const jumpBtn = await screen.findByTestId('terminal-scroll-bottom');
    expect(jumpBtn.textContent).toContain('Ir ao fim');
    fireEvent.click(jumpBtn);
    expect(reading.scrollTop).toBe(1000);
    expect(screen.queryByTestId('terminal-scroll-bottom')).toBeNull();

    // Alterna para o modo Terminal e persiste a preferência no localStorage
    const toggle = screen.getByTestId('terminal-mode-toggle');
    expect(toggle.textContent).toContain('Leitura');
    fireEvent.click(toggle);
    expect(localStorage.getItem('orquestra.mobile.terminalMode')).toBe('terminal');
    expect(screen.getByTestId('terminal-host').hidden).toBe(false);
    expect(screen.queryByTestId('terminal-reading')).toBeNull();
    expect(toggle.textContent).toContain('Terminal');

    // Nova montagem respeita a escolha salva no localStorage
    cleanup();
    setup();
    await waitFor(() => expect(screen.getByTestId('terminal-host').hidden).toBe(false));
  });

  it('readXtermBufferText extrai linhas com translateToString(true), junta soft-wrap (isWrapped) e remove linhas vazias no fim', () => {
    const fakeLines = [
      { isWrapped: false, translateToString: (trim: boolean) => (trim ? 'linha A' : 'linha A ') },
      { isWrapped: true, translateToString: (trim: boolean) => (trim ? 'continua' : 'continua   ') },
      { isWrapped: false, translateToString: () => '' },
      { isWrapped: false, translateToString: (trim: boolean) => (trim ? 'linha B' : 'linha B  ') },
      { isWrapped: false, translateToString: () => '' },
      { isWrapped: false, translateToString: () => '' },
    ];
    const fakeTerm = {
      buffer: {
        active: {
          length: fakeLines.length,
          getLine: (i: number) => fakeLines[i],
        },
      },
    };
    expect(readXtermBufferText(fakeTerm as never)).toBe('linha A continua\n\nlinha B');
  });

  it('no modo Terminal não chama readText nem fitWidth em novas saídas e lê via onUpdate após parse do xterm', async () => {
    const { view, emit } = setup();
    await waitFor(() => expect(view.load).toHaveBeenCalledTimes(1));
    expect(view.readText).toHaveBeenCalledTimes(1);

    // Muda para modo Terminal: fitWidth roda uma vez na troca
    fireEvent.click(screen.getByTestId('terminal-mode-toggle'));
    expect(view.fitWidth).toHaveBeenCalledTimes(1);
    view.readText.mockClear();
    view.fitWidth.mockClear();

    // Novas saídas em modo Terminal não varrem readText nem chamam fitWidth
    emit({ kind: 'output', event: { type: 'terminal.output', name: 'revisor', data: 'nova saída', workspaceId: 'w1' } });
    await new Promise((r) => setTimeout(r, 120));
    expect(view.readText).not.toHaveBeenCalled();
    expect(view.fitWidth).not.toHaveBeenCalled();
  });
});
