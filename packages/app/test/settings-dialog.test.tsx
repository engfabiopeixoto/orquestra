// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';

vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

afterEach(cleanup);

describe('SettingsDialog', () => {
  it('carrega os padrões, salva e fecha', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        return method === 'settings.get' ? { defaultArgs: { claude: ['--a'], agy: [], codex: [] }, canvas: { snapToGrid: true } } : params;
      }) as CommandApi['command'],
    };
    const onClose = vi.fn();
    render(<SettingsDialog api={api} onClose={onClose} />);
    const claude = (await screen.findByDisplayValue('--a')) as HTMLInputElement;
    fireEvent.change(claude, { target: { value: '--dangerously-skip-permissions' } });
    fireEvent.change(screen.getByTestId('settings-agy'), { target: { value: '--modelo "x y"' } });
    fireEvent.change(screen.getByTestId('settings-codex'), { target: { value: '--no-daemon --model "modelo de teste"' } });
    expect((screen.getByTestId('settings-snap-grid') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('settings-snap-grid'));
    fireEvent.click(screen.getByTestId('settings-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual(['settings.update', { defaultArgs: { claude: ['--dangerously-skip-permissions'], agy: ['--modelo', 'x y'], codex: ['--no-daemon', '--model', 'modelo de teste'] }, canvas: { snapToGrid: false, motion: 'contained' } }]);
  });

  it('salva o movimento escolhido e avisa o canvas', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = {
      command: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        return method === 'settings.get' ? { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true } } : params;
      }) as CommandApi['command'],
    };
    const onCanvasChange = vi.fn();
    render(<SettingsDialog api={api} onClose={() => {}} onCanvasChange={onCanvasChange} />);
    const select = (await screen.findByTestId('settings-motion')) as HTMLSelectElement;
    expect(select.value).toBe('contained');
    fireEvent.change(select, { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    await waitFor(() => expect(onCanvasChange).toHaveBeenCalledWith({ snapToGrid: true, motion: 'minimal' }));
    expect(calls.at(-1)).toEqual(['settings.update', { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'minimal' } }]);
  });

  it('reservado vira erro e não salva', async () => {
    const calls: string[] = [];
    const api = { command: (async (method: string) => { calls.push(method); return { defaultArgs: { claude: [], agy: [] }, canvas: { snapToGrid: true } }; }) as CommandApi['command'] };
    render(<SettingsDialog api={api} onClose={() => {}} />);
    await waitFor(() => expect(calls).toEqual(['settings.get']));
    fireEvent.change(screen.getByTestId('settings-claude'), { target: { value: '-c' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    expect(screen.getByTestId('settings-error').textContent).toMatch(/Padrão do claude: O argumento -c é controlado/);
    expect(calls).toEqual(['settings.get']);
  });
  it('argumento reservado do Codex não pode sobrescrever a retomada', async () => {
    const command = vi.fn().mockResolvedValue({ defaultArgs: { claude: [], agy: [], codex: [] } });
    render(<SettingsDialog api={{ command } as unknown as CommandApi} onClose={() => {}} />);
    fireEvent.change(await screen.findByTestId('settings-codex'), { target: { value: 'resume --last' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    expect(screen.getByTestId('settings-error').textContent).toContain('Padrão do codex:');
    expect(command).toHaveBeenCalledTimes(1);
  });
});
