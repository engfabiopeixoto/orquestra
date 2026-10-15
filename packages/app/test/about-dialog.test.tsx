// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutDialog } from '../src/renderer/src/components/AboutDialog';

const bridge = vi.hoisted(() => {
  const api = {
    getAppInfo: vi.fn().mockResolvedValue({ version: '0.3.9', electron: '44.7.0', chrome: '144.0', node: '24.0.0', platform: 'win32', arch: 'x64', osRelease: '10.0.1' }),
    appAction: vi.fn().mockResolvedValue(undefined),
    writeClipboard: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(window, { orquestra: api });
  return api;
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AboutDialog', () => {
  it('mostra a versão e foca Fechar ao abrir', async () => {
    render(<AboutDialog onClose={() => {}} />);
    expect(await screen.findByText('Versão 0.3.9')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.getByText('Electron')).toBeTruthy();
    expect(screen.getByText('Chromium')).toBeTruthy();
    expect(screen.getByText('Node')).toBeTruthy();
    expect(screen.getByText('44.7.0')).toBeTruthy();
    expect(screen.getByText('144.0')).toBeTruthy();
    expect(screen.getByText('24.0.0')).toBeTruthy();
  });

  it('copia as informações do app e do sistema, uma por linha', async () => {
    render(<AboutDialog onClose={() => {}} />);
    await screen.findByText('Versão 0.3.9');
    fireEvent.click(screen.getByRole('button', { name: 'Copiar informações' }));
    await waitFor(() => expect(bridge.writeClipboard).toHaveBeenCalledWith(
      'Orquestra\nVersão: 0.3.9\nElectron: 44.7.0\nChromium: 144.0\nNode: 24.0.0\nSistema operacional: win32 x64 10.0.1',
    ));
  });

  it('abre o repositório pelo app-action', async () => {
    render(<AboutDialog onClose={() => {}} />);
    await screen.findByText('Versão 0.3.9');
    fireEvent.click(screen.getByRole('button', { name: 'Ver no GitHub' }));
    expect(bridge.appAction).toHaveBeenCalledWith('open-repo');
  });

  it('fecha pelo botão ou por Escape', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<AboutDialog onClose={onClose} />);
    await screen.findByText('Versão 0.3.9');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    rerender(<AboutDialog onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
