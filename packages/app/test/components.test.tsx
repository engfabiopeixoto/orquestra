// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewTerminalDialog, suggestName } from '../src/renderer/src/components/NewTerminalDialog';
import { NodeErrorBoundary } from '../src/renderer/src/components/NodeErrorBoundary';
import { QueuePanel } from '../src/renderer/src/components/QueuePanel';

afterEach(cleanup);

describe('QueuePanel', () => {
  it('lista os pedidos e cancela só os prompts', () => {
    const onCancel = vi.fn();
    render(
      <QueuePanel
        entries={[
          { askId: 'a1', from: 'A', preview: 'revise o plano', status: 'running', kind: 'prompt' },
          { askId: 'd1', from: 'B', preview: '[orq] Resposta…', status: 'queued', kind: 'delivery' },
        ]}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('revise o plano')).toBeDefined();
    fireEvent.click(screen.getByTestId('queue-cancel-a1'));
    expect(onCancel).toHaveBeenCalledWith('a1');
    expect(screen.queryByTestId('queue-cancel-d1')).toBeNull();
  });

  it('fila vazia mostra um texto claro', () => {
    render(<QueuePanel entries={[]} onCancel={() => {}} />);
    expect(screen.getByText('Fila vazia.')).toBeDefined();
  });
});

describe('NewTerminalDialog', () => {
  it('preenche e envia os argumentos padrão do Codex', async () => {
    const onCreate = vi.fn();
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [], codex: ['--model', 'modelo de teste'] }} onCancel={() => {}} onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('agent-codex'));
    expect((screen.getByTestId('new-terminal-args') as HTMLInputElement).value).toBe('--model "modelo de teste"');
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', args: ['--model', 'modelo de teste'] }));
  });
  it('sugere um nome livre por tipo de agente', () => {
    expect(suggestName('shell', ['shell-1', 'shell-2'])).toBe('shell-3');
  });

  it('recusa nome repetido e nome com espaço', () => {
    const onCreate = vi.fn();
    render(<NewTerminalDialog projectDir="C:/p" existingNames={['revisor']} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);
    fireEvent.change(screen.getByTestId('new-terminal-name'), { target: { value: 'revisor' } });
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    expect(screen.getByTestId('new-terminal-error').textContent).toMatch(/Já existe/);
    fireEvent.change(screen.getByTestId('new-terminal-name'), { target: { value: 'com espaço' } });
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    expect(screen.getByTestId('new-terminal-error').textContent).toMatch(/sem espaço/);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('Codex fica habilitado e a criação usa a pasta do projeto por padrão', () => {
    const onCreate = vi.fn();
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);
    expect((screen.getByTestId('agent-codex') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('agent-shell'));
    fireEvent.change(screen.getByTestId('new-terminal-name'), { target: { value: 'console' } });
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    expect(onCreate).toHaveBeenCalledWith({ name: 'console', agent: 'shell', cwd: 'C:/p', resume: false, args: [], regente: false, monitor: false });
  });
});

describe('NodeErrorBoundary', () => {
  it('isola o erro do nó e o reporta', () => {
    const reportError = vi.fn();
    Object.assign(window, { orquestra: { reportError } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('quebrou');
    };
    render(
      <NodeErrorBoundary name="A">
        <Boom />
      </NodeErrorBoundary>,
    );
    expect(screen.getByText(/Este terminal falhou ao desenhar/)).toBeDefined();
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('quebrou'), expect.any(String));
  });
});

describe('ContextBar', () => {
  it('desenha sem laço de renderização quando o terminal não tem fila', async () => {
    Object.assign(window, { orquestra: { invoke: vi.fn(), reportError: vi.fn() } });
    // Importação tardia: o módulo cria a ponte de comandos com window.orquestra ao carregar.
    const { ContextBar } = await import('../src/renderer/src/components/ContextBar');
    const { appStore } = await import('../src/renderer/src/store');
    appStore.getState().addTerminal({ name: 'A', agent: 'shell', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false });
    render(<ContextBar name="A" />);
    expect(screen.getByTestId('ctx-queue').textContent).toBe('Fila');
  });

  it('Editar abre o diálogo de edição pelo store', async () => {
    Object.assign(window, { orquestra: { invoke: vi.fn(), reportError: vi.fn() } });
    const { ContextBar } = await import('../src/renderer/src/components/ContextBar');
    const { appStore } = await import('../src/renderer/src/store');
    appStore.getState().addTerminal({ name: 'A', agent: 'shell', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false });
    render(<ContextBar name="A" />);
    fireEvent.click(screen.getByTestId('ctx-edit'));
    expect(appStore.getState().editing).toBe('A');
  });
});
