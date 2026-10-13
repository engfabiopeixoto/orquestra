// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewTerminalDialog } from '../src/renderer/src/components/NewTerminalDialog';

afterEach(cleanup);

describe('NewTerminalDialog (resposta assíncrona)', () => {
  it('desabilita botão de criar enquanto espera a resposta (sem envio duplo)', async () => {
    let resolveCreation: () => void = () => {};
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { resolveCreation = resolve; }));

    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);

    const submitBtn = screen.getByTestId('new-terminal-submit') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    fireEvent.click(submitBtn);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(submitBtn.disabled).toBe(true);

    // Segundo clique não dispara envio duplo
    fireEvent.click(submitBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);

    resolveCreation();
    await Promise.resolve();
  });

  it('mantém os campos preenchidos e exibe mensagem de erro se a criação falhar', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('A pasta não existe. Escolha outra.'));

    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);

    const nameInput = screen.getByTestId('new-terminal-name') as HTMLInputElement;
    const cwdInput = screen.getByTestId('new-terminal-cwd') as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'meu-terminal' } });
    fireEvent.change(cwdInput, { target: { value: 'C:/pasta-inexistente' } });

    const submitBtn = screen.getByTestId('new-terminal-submit') as HTMLButtonElement;
    fireEvent.click(submitBtn);

    const errorEl = await screen.findByTestId('new-terminal-error');
    expect(errorEl.textContent).toBe('A pasta não existe. Escolha outra.');

    // Campos continuam preenchidos com o que foi digitado
    expect(nameInput.value).toBe('meu-terminal');
    expect(cwdInput.value).toBe('C:/pasta-inexistente');
    expect(submitBtn.disabled).toBe(false);
  });

  it('retomar sessão vem ligado e vai no onCreate; shell desabilita a opção', async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);
    const resume = screen.getByTestId('new-terminal-resume') as HTMLInputElement;
    expect(resume.checked).toBe(true);
    fireEvent.click(screen.getByTestId('agent-shell'));
    expect(resume.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('agent-claude'));
    fireEvent.click(resume);
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude', resume: false })));
  });

  it('argumentos vêm do padrão do tipo e vão no onCreate', async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: ['--dangerously-skip-permissions'], agy: ['--x'] }} onCancel={() => {}} onCreate={onCreate} />);
    const args = screen.getByTestId('new-terminal-args') as HTMLInputElement;
    expect(args.value).toBe('--dangerously-skip-permissions');
    fireEvent.click(screen.getByTestId('agent-agy'));
    expect(args.value).toBe('--x');
    fireEvent.click(screen.getByTestId('agent-shell'));
    expect(args.value).toBe('');
    fireEvent.click(screen.getByTestId('agent-claude'));
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude', args: ['--dangerously-skip-permissions'] })));
  });

  it('trocar o tipo mantém argumentos que você editou', () => {
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: ['--a'], agy: ['--b'] }} onCancel={() => {}} onCreate={vi.fn(async () => {})} />);
    const args = screen.getByTestId('new-terminal-args') as HTMLInputElement;
    fireEvent.change(args, { target: { value: '--meu' } });
    fireEvent.click(screen.getByTestId('agent-agy'));
    expect(args.value).toBe('--meu');
  });

  it('argumento reservado vira erro no diálogo, sem criar', () => {
    const onCreate = vi.fn(async () => {});
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);
    fireEvent.change(screen.getByTestId('new-terminal-args'), { target: { value: '--session-id x' } });
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    expect(screen.getByTestId('new-terminal-error').textContent).toMatch(/--session-id é controlado/);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('regente e função vão no onCreate; shell desabilita a função', async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} personas={['revisor']} onCancel={() => {}} onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('new-terminal-regente'));
    fireEvent.change(screen.getByTestId('new-terminal-persona'), { target: { value: 'revisor' } });
    fireEvent.click(screen.getByTestId('agent-shell'));
    expect((screen.getByTestId('new-terminal-persona') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('agent-claude'));
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ regente: true, persona: 'revisor' })));
  });

  it('monitorar atividade começa marcado para claude, desmarcado ao trocar para shell, e vai no onCreate', async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewTerminalDialog projectDir="C:/p" existingNames={[]} defaultArgs={{ claude: [], agy: [] }} onCancel={() => {}} onCreate={onCreate} />);
    const monitor = screen.getByTestId('new-terminal-monitor') as HTMLInputElement;
    expect(monitor.checked).toBe(true);
    fireEvent.click(screen.getByTestId('agent-shell'));
    expect(monitor.checked).toBe(false);
    fireEvent.click(screen.getByTestId('agent-claude'));
    expect(monitor.checked).toBe(true);
    fireEvent.click(screen.getByTestId('new-terminal-submit'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude', monitor: true })));
  });
});

