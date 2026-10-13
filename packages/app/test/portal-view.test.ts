import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';

const mockEnableDeviceEmulation = vi.fn();
const mockDisableDeviceEmulation = vi.fn();
const mockSetUserAgent = vi.fn();
const mockLoadURL = vi.fn().mockResolvedValue(undefined);
const mockCanGoBack = vi.fn().mockReturnValue(true);
const mockGoBack = vi.fn();
const mockReload = vi.fn();
const mockSetBounds = vi.fn();
const mockSetVisible = vi.fn();

vi.mock('electron', () => {
  class MockWebContents {
    canGoBack = mockCanGoBack;
    canGoForward = vi.fn().mockReturnValue(false);
    goBack = mockGoBack;
    goForward = vi.fn();
    reload = mockReload;
    stop = vi.fn();
    loadURL = mockLoadURL;
    enableDeviceEmulation = mockEnableDeviceEmulation;
    disableDeviceEmulation = mockDisableDeviceEmulation;
    setUserAgent = mockSetUserAgent;
    getUserAgent = vi.fn().mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Desktop');
    isLoading = vi.fn().mockReturnValue(false);
    setWindowOpenHandler = vi.fn();
    on = vi.fn((event: string, listener: () => void) => { if (event === 'dom-ready') listener(); });
    close = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    destroy = vi.fn();
  }

  class MockWebContentsView {
    webContents = new MockWebContents();
    setBounds = mockSetBounds;
    setVisible = mockSetVisible;
  }

  return {
    WebContentsView: MockWebContentsView,
    shell: { openExternal: vi.fn() },
  };
});

import { PortalView } from '../src/main/portal/portal-view';
import { getDevicePreset } from '../src/shared/portal-protocol';

describe('PortalView', () => {
  it('aplica emulação para presets mobile com resolução, escala e user agent', () => {
    const fakeSession = {} as Session;
    const view = new PortalView({
      portalId: 'p-1',
      tabId: 't-1',
      workspaceId: 'ws-1',
      session: fakeSession,
      onEvent: () => {},
    });

    const iphonePreset = getDevicePreset('iphone-15-pro');
    view.applyEmulation(iphonePreset, 'portrait');

    expect(mockEnableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        screenPosition: 'mobile',
        screenSize: { width: 393, height: 852 },
        deviceScaleFactor: 3,
      }),
    );
    expect(mockSetUserAgent).toHaveBeenCalledWith(iphonePreset.userAgent);

    // Agora rotaciona para landscape
    view.applyEmulation(iphonePreset, 'landscape');
    expect(mockEnableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        screenPosition: 'mobile',
        screenSize: { width: 852, height: 393 },
      }),
    );
  });

  it('desativa emulação de dispositivo ao voltar para preset desktop', () => {
    const fakeSession = {} as Session;
    const view = new PortalView({
      portalId: 'p-1',
      tabId: 't-1',
      workspaceId: 'ws-1',
      session: fakeSession,
      onEvent: () => {},
    });

    const iphonePreset = getDevicePreset('iphone-15-pro');
    view.applyEmulation(iphonePreset, 'portrait');

    const desktopPreset = getDevicePreset('desktop-compact');
    view.applyEmulation(desktopPreset, 'portrait');

    expect(mockDisableDeviceEmulation).toHaveBeenCalled();
    expect(mockSetUserAgent).toHaveBeenCalledWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Desktop');
  });

  it('não desativa emulação se nunca esteve em modo mobile', () => {
    mockDisableDeviceEmulation.mockClear();
    const fakeSession = {} as Session;
    const view = new PortalView({
      portalId: 'p-1',
      tabId: 't-1',
      workspaceId: 'ws-1',
      session: fakeSession,
      onEvent: () => {},
    });

    const desktopPreset = getDevicePreset('desktop-compact');
    view.applyEmulation(desktopPreset, 'portrait');

    expect(mockDisableDeviceEmulation).not.toHaveBeenCalled();
  });

  it('gerencia bounds e visibilidade', () => {
    const fakeSession = {} as Session;
    const view = new PortalView({
      portalId: 'p-1',
      tabId: 't-1',
      workspaceId: 'ws-1',
      session: fakeSession,
      onEvent: () => {},
    });

    view.setBounds({ x: 100, y: 150, width: 800, height: 600 });
    expect(mockSetBounds).toHaveBeenCalledWith({ x: 100, y: 150, width: 800, height: 600 });
    expect(view.getBounds()).toEqual({ x: 100, y: 150, width: 800, height: 600 });

    view.setVisible(false);
    expect(mockSetVisible).toHaveBeenCalledWith(false);
  });

  it('executa ações de navegação como voltar e recarregar', () => {
    const fakeSession = {} as Session;
    const view = new PortalView({
      portalId: 'p-1',
      tabId: 't-1',
      workspaceId: 'ws-1',
      session: fakeSession,
      onEvent: () => {},
    });

    view.act('back');
    expect(mockGoBack).toHaveBeenCalled();

    view.act('reload');
    expect(mockReload).toHaveBeenCalled();

    expect(view.canGoBack()).toBe(true);
    expect(view.canGoForward()).toBe(false);
    expect(view.isLoading()).toBe(false);

    view.destroy();
    expect(view.view.webContents.close).toHaveBeenCalled();
  });
});
