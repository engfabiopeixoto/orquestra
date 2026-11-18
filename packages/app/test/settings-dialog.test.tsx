// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';

vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

afterEach(cleanup);

function mockApi(overrides?: (method: string, params: unknown) => unknown) {
  const calls: Array<[string, unknown]> = [];
  const api = {
    command: (async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (overrides) {
        const custom = overrides(method, params);
        if (custom !== undefined) return custom;
      }
      if (method === 'settings.get') return { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true } };
      if (method === 'remote.status') return { enabled: false, port: 47820, localUrl: 'http://127.0.0.1:47820', devicesCount: 0 };
      if (method === 'remote.devices') return { devices: [] };
      return params;
    }) as CommandApi['command'],
  };
  return { api, calls };
}

describe('SettingsDialog', () => {
  it('carrega os padrões, salva e fecha', async () => {
    const { api, calls } = mockApi((method) =>
      method === 'settings.get' ? { defaultArgs: { claude: ['--a'], agy: [], codex: [] }, canvas: { snapToGrid: true } } : undefined,
    );
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
    expect(calls.filter(([m]) => m === 'settings.update').at(-1)).toEqual([
      'settings.update',
      {
        defaultArgs: {
          claude: ['--dangerously-skip-permissions'],
          agy: ['--modelo', 'x y'],
          codex: ['--no-daemon', '--model', 'modelo de teste'],
        },
        canvas: { snapToGrid: false, motion: 'contained' },
      },
    ]);
  });

  it('salva o movimento escolhido e avisa o canvas', async () => {
    const { api, calls } = mockApi();
    const onCanvasChange = vi.fn();
    render(<SettingsDialog api={api} onClose={() => {}} onCanvasChange={onCanvasChange} />);
    const select = (await screen.findByTestId('settings-motion')) as HTMLSelectElement;
    expect(select.value).toBe('contained');
    fireEvent.change(select, { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    await waitFor(() => expect(onCanvasChange).toHaveBeenCalledWith({ snapToGrid: true, motion: 'minimal' }));
    expect(calls.filter(([m]) => m === 'settings.update').at(-1)).toEqual([
      'settings.update',
      { defaultArgs: { claude: [], agy: [], codex: [] }, canvas: { snapToGrid: true, motion: 'minimal' } },
    ]);
  });

  it('reservado vira erro e não salva', async () => {
    const { api, calls } = mockApi((method) =>
      method === 'settings.get' ? { defaultArgs: { claude: [], agy: [] }, canvas: { snapToGrid: true } } : undefined,
    );
    render(<SettingsDialog api={api} onClose={() => {}} />);
    await waitFor(() => expect(calls.some(([m]) => m === 'settings.get')).toBe(true));
    fireEvent.change(screen.getByTestId('settings-claude'), { target: { value: '-c' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    expect(screen.getByTestId('settings-error').textContent).toMatch(/Padrão do claude: O argumento -c é controlado/);
    expect(calls.some(([m]) => m === 'settings.update')).toBe(false);
  });

  it('argumento reservado do Codex não pode sobrescrever a retomada', async () => {
    const { api, calls } = mockApi();
    render(<SettingsDialog api={api} onClose={() => {}} />);
    fireEvent.change(await screen.findByTestId('settings-codex'), { target: { value: 'resume --last' } });
    fireEvent.click(screen.getByTestId('settings-submit'));
    expect(screen.getByTestId('settings-error').textContent).toContain('Padrão do codex:');
    expect(calls.some(([m]) => m === 'settings.update')).toBe(false);
  });

  it('liga acesso pelo celular, gera QR de pareamento e revoga dispositivo', async () => {
    let enabled = false;
    let devices = [{ id: 'dev-1', name: 'Pixel 8', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: null }];
    const { api, calls } = mockApi((method, params) => {
      if (method === 'remote.status') return { enabled, port: 47820, localUrl: 'http://127.0.0.1:47820', devicesCount: devices.length };
      if (method === 'remote.enable') {
        enabled = (params as { enabled: boolean }).enabled;
        return { enabled, port: 47820, localUrl: 'http://127.0.0.1:47820', devicesCount: devices.length };
      }
      if (method === 'remote.pair') {
        return { token: 'abc123', url: 'http://127.0.0.1:47820/?pair=abc123', expiresAt: '2026-11-18T00:05:00Z' };
      }
      if (method === 'remote.devices') return { devices };
      if (method === 'remote.revoke') {
        devices = devices.filter((d) => d.id !== (params as { id: string }).id);
        return {};
      }
      return undefined;
    });

    render(<SettingsDialog api={api} onClose={() => {}} />);
    const toggle = (await screen.findByTestId('settings-remote-enable')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId('settings-remote-status').textContent).toContain('Desligado');
    expect((screen.getByTestId('settings-remote-pair') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('settings-remote-status').textContent).toContain('Ligado'));
    expect(screen.getByTestId('settings-remote-url').textContent).toContain('http://127.0.0.1:47820');

    fireEvent.click(screen.getByTestId('settings-remote-pair'));
    const qr = (await screen.findByTestId('settings-remote-qr')) as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect((screen.getByTestId('settings-remote-pair-url') as HTMLInputElement).value).toBe('http://127.0.0.1:47820/?pair=abc123');

    fireEvent.click(screen.getByTestId('settings-remote-revoke-dev-1'));
    await waitFor(() => expect(calls.some(([m, p]) => m === 'remote.revoke' && (p as { id: string }).id === 'dev-1')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('settings-remote-revoke-dev-1')).toBeNull());
  });
});
