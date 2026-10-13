// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { PersonasDialog } from '../src/renderer/src/components/PersonasDialog';

vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

afterEach(cleanup);

describe('PersonasDialog', () => {
  it('lista vinda de persona.list mostra revisor com "projeto" e geral com "global"', async () => {
    const api = {
      command: (async (method: string) => {
        if (method === 'persona.list') {
          return {
            personas: [
              { name: 'revisor', text: 'Revise o código.', scope: 'project' },
              { name: 'geral', text: 'Ajude.', scope: 'global' },
            ],
          };
        }
        return {};
      }) as CommandApi['command'],
    };

    render(<PersonasDialog api={api} hasProject={true} onClose={() => {}} />);
    const itemRevisor = await screen.findByTestId('personas-item-revisor');
    expect(itemRevisor.textContent).toContain('revisor');
    expect(itemRevisor.textContent).toContain('projeto');

    const itemGeral = screen.getByTestId('personas-item-geral');
    expect(itemGeral.textContent).toContain('geral');
    expect(itemGeral.textContent).toContain('global');
  });

  it('criar executor com texto e escopo "Global" chama persona.save com { name: \'executor\', text: \'Faça.\', scope: \'global\' } e recarrega a lista', async () => {
    const calls: Array<[string, unknown]> = [];
    let listCount = 0;
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === 'persona.list') {
          listCount++;
          if (listCount === 1) return { personas: [] };
          return { personas: [{ name: 'executor', text: 'Faça.', scope: 'global' }] };
        }
        return {};
      }) as CommandApi['command'],
    };

    render(<PersonasDialog api={api} hasProject={true} onClose={() => {}} />);
    await waitFor(() => expect(calls.length).toBe(1));

    fireEvent.click(screen.getByTestId('personas-new'));
    fireEvent.change(screen.getByTestId('personas-name'), { target: { value: 'executor' } });
    fireEvent.change(screen.getByTestId('personas-text'), { target: { value: 'Faça.' } });
    fireEvent.change(screen.getByTestId('personas-scope'), { target: { value: 'global' } });
    fireEvent.click(screen.getByTestId('personas-save'));

    await waitFor(() => {
      expect(calls).toContainEqual(['persona.save', { name: 'executor', text: 'Faça.', scope: 'global' }]);
    });
    // Segunda chamada a persona.list
    expect(calls.filter(([method]) => method === 'persona.list').length).toBe(2);
    expect(await screen.findByTestId('personas-item-executor')).toBeTruthy();
  });

  it('nome com espaço mostra erro e não envia', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === 'persona.list') return { personas: [] };
        return {};
      }) as CommandApi['command'],
    };

    render(<PersonasDialog api={api} hasProject={true} onClose={() => {}} />);
    await screen.findByTestId('personas-new');
    fireEvent.click(screen.getByTestId('personas-new'));
    fireEvent.change(screen.getByTestId('personas-name'), { target: { value: 'nome invalido' } });
    fireEvent.change(screen.getByTestId('personas-text'), { target: { value: 'Texto' } });
    fireEvent.click(screen.getByTestId('personas-save'));

    expect(screen.getByTestId('personas-error').textContent).toBe(
      'Nome inválido: use só letras, números, "_", "." ou "-", sem espaço. Escolha outro nome.',
    );
    expect(calls.some(([method]) => method === 'persona.save')).toBe(false);
  });

  it('texto vazio mostra "o texto da função não pode ficar vazio" e não envia', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === 'persona.list') return { personas: [] };
        return {};
      }) as CommandApi['command'],
    };

    render(<PersonasDialog api={api} hasProject={true} onClose={() => {}} />);
    await screen.findByTestId('personas-new');
    fireEvent.click(screen.getByTestId('personas-new'));
    fireEvent.change(screen.getByTestId('personas-name'), { target: { value: 'valido' } });
    fireEvent.change(screen.getByTestId('personas-text'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('personas-save'));

    expect(screen.getByTestId('personas-error').textContent).toBe('o texto da função não pode ficar vazio');
    expect(calls.some(([method]) => method === 'persona.save')).toBe(false);
  });

  it('sem projeto (hasProject={false}), a opção "Projeto" fica desabilitada e o escopo inicial é "Global"', async () => {
    const api = {
      command: (async (method: string) => {
        if (method === 'persona.list') return { personas: [] };
        return {};
      }) as CommandApi['command'],
    };

    render(<PersonasDialog api={api} hasProject={false} onClose={() => {}} />);
    await screen.findByTestId('personas-new');
    fireEvent.click(screen.getByTestId('personas-new'));

    const select = screen.getByTestId('personas-scope') as HTMLSelectElement;
    expect(select.value).toBe('global');
    const optionProjeto = screen.getByRole('option', { name: 'Projeto' }) as HTMLOptionElement;
    expect(optionProjeto.disabled).toBe(true);
  });

  it('apagar com confirmação chama persona.remove com o escopo do item', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === 'persona.list') {
          return { personas: [{ name: 'antigo', text: 'Algo', scope: 'project' }] };
        }
        return {};
      }) as CommandApi['command'],
    };

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PersonasDialog api={api} hasProject={true} onClose={() => {}} />);
    const removeBtn = await screen.findByTestId('personas-remove-antigo');
    fireEvent.click(removeBtn);

    expect(confirm).toHaveBeenCalledWith('Apagar a função antigo?');
    expect(calls).toContainEqual(['persona.remove', { name: 'antigo', scope: 'project' }]);
    confirm.mockRestore();
  });
});
