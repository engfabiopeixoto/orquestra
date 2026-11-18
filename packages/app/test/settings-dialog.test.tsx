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
    const qr = await screen.findByTestId('settings-remote-qr');
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toBe('QR code para parear o celular');
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
    expect((screen.getByTestId('settings-remote-pair-url') as HTMLInputElement).value).toBe('http://127.0.0.1:47820/?pair=abc123');

    fireEvent.click(screen.getByTestId('settings-remote-revoke-dev-1'));
    await waitFor(() => expect(calls.some(([m, p]) => m === 'remote.revoke' && (p as { id: string }).id === 'dev-1')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('settings-remote-revoke-dev-1')).toBeNull());
  });

  it('mostra o estado e a URL https do Tailscale, o QR apontando para ela, e o motivo/ação do plano B quando o serve falha', async () => {
    let fallbackActive = false;
    const { api, calls } = mockApi((method, params) => {
      if (method === 'remote.status') {
        return {
          enabled: true,
          port: 47820,
          localUrl: 'http://127.0.0.1:47820',
          devicesCount: 0,
          tailscale: {
            state: 'error',
            dnsName: 'meu-pc.tailnet.ts.net',
            url: null,
            error: 'Certificados HTTPS não estão habilitados na sua tailnet. Ative HTTPS ou use o plano B em HTTP.',
            tailscaleIp: '100.113.98.14',
          },
        };
      }
      if (method === 'remote.enable') {
        const p = params as { enabled: boolean; fallbackHttp?: boolean };
        fallbackActive = Boolean(p.fallbackHttp);
        return {
          enabled: p.enabled,
          port: 47820,
          localUrl: 'http://127.0.0.1:47820',
          devicesCount: 0,
          tailscale: fallbackActive
            ? {
                state: 'fallback',
                dnsName: 'meu-pc.tailnet.ts.net',
                url: 'http://100.113.98.14:47820',
                error: 'Certificados HTTPS não estão habilitados na sua tailnet. Ative HTTPS ou use o plano B em HTTP.',
                tailscaleIp: '100.113.98.14',
              }
            : {
                state: 'serving',
                dnsName: 'meu-pc.tailnet.ts.net',
                url: 'https://meu-pc.tailnet.ts.net:8443',
                error: null,
                tailscaleIp: '100.113.98.14',
              },
        };
      }
      if (method === 'remote.pair') {
        const base = fallbackActive ? 'http://100.113.98.14:47820' : 'https://meu-pc.tailnet.ts.net:8443';
        return { token: 'tok999', url: `${base}/?pair=tok999`, expiresAt: '2026-11-18T00:05:00Z' };
      }
      return undefined;
    });

    render(<SettingsDialog api={api} onClose={() => {}} />);
    expect((await screen.findByTestId('settings-remote-tailscale-state')).textContent).toContain('Indisponível');
    expect(screen.getByTestId('settings-remote-tailscale-error').textContent).toContain('Certificados HTTPS');

    const fbBtn = screen.getByTestId('settings-remote-fallback-btn');
    expect(fbBtn.textContent).toContain('100.113.98.14:47820');
    fireEvent.click(fbBtn);

    await waitFor(() =>
      expect(calls.some(([m, p]) => m === 'remote.enable' && (p as any).fallbackHttp === true)).toBe(true),
    );
    expect(screen.getByTestId('settings-remote-tailscale-state').textContent).toContain('Plano B ativo');
    expect(screen.getByTestId('settings-remote-tailscale-url').textContent).toContain('http://100.113.98.14:47820');

    // Simula desligar e religar com HTTPS ativo e parear: o QR e o link apontam para a URL do Tailscale
    fireEvent.click(screen.getByTestId('settings-remote-enable'));
    await waitFor(() => expect(screen.getByTestId('settings-remote-status').textContent).toContain('Desligado'));
    fireEvent.click(screen.getByTestId('settings-remote-enable'));
    await waitFor(() => expect(screen.getByTestId('settings-remote-tailscale-state').textContent).toContain('HTTPS ativo'));
    expect(screen.getByTestId('settings-remote-tailscale-url').textContent).toContain('https://meu-pc.tailnet.ts.net:8443');

    fireEvent.click(screen.getByTestId('settings-remote-pair'));
    expect((await screen.findByTestId('settings-remote-pair-url') as HTMLInputElement).value).toBe(
      'https://meu-pc.tailnet.ts.net:8443/?pair=tok999',
    );
  });
});
