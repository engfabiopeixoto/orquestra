import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => {
  class MockWebContents {
    canGoBack = vi.fn().mockReturnValue(true);
    canGoForward = vi.fn().mockReturnValue(false);
    goBack = vi.fn();
    goForward = vi.fn();
    reload = vi.fn();
    stop = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    enableDeviceEmulation = vi.fn();
    disableDeviceEmulation = vi.fn();
    setUserAgent = vi.fn();
    getUserAgent = vi.fn().mockReturnValue('Mozilla/5.0 Desktop');
    isLoading = vi.fn().mockReturnValue(false);
    setWindowOpenHandler = vi.fn();
    on = vi.fn();
    close = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    destroy = vi.fn();
    capturePage = vi.fn().mockResolvedValue({ toDataURL: () => 'data:image/png;base64,snapshot' });
  }

  class MockWebContentsView {
    webContents = new MockWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }

  return {
    WebContentsView: MockWebContentsView,
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setPermissionRequestHandler: vi.fn(),
      }),
    },
    shell: {
      openExternal: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    },
  };
});

import { PortalManager } from '../src/main/portal/portal-manager';
import type { PortalEvent } from '../src/shared/portal-protocol';

function createMockWindow() {
  const addedViews: unknown[] = [];
  const removedViews: unknown[] = [];
  const win = {
    contentView: {
      addChildView: vi.fn((v) => addedViews.push(v)),
      removeChildView: vi.fn((v) => removedViews.push(v)),
    },
  } as unknown as BrowserWindow;
  return { win, addedViews, removedViews };
}

describe('PortalManager', () => {
  it('cria portal e anexa a view na janela se estiver no workspace ativo', () => {
    const { win, addedViews } = createMockWindow();
    const events: PortalEvent[] = [];
    const manager = new PortalManager(() => win, (e) => events.push(e));

    manager.setActiveWorkspace('ws-1');

    const portal = manager.createPortal({
      portalId: 'portal-1',
      workspaceId: 'ws-1',
      initialUrl: 'https://duckduckgo.com',
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });

    expect(portal.id).toBe('portal-1');
    expect(portal.workspaceId).toBe('ws-1');
    expect(portal.tabs).toHaveLength(1);
    expect(portal.tabs[0]?.url).toBe('https://duckduckgo.com');
    expect(addedViews).toHaveLength(1);
  });

  it('respeita o limite estrito de 3 workspaces simultâneos descartando o mais antigo', () => {
    const { win } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});

    // Cria portais nos workspaces 1, 2 e 3
    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1' });

    manager.setActiveWorkspace('ws-2');
    manager.createPortal({ portalId: 'p2', workspaceId: 'ws-2' });

    manager.setActiveWorkspace('ws-3');
    manager.createPortal({ portalId: 'p3', workspaceId: 'ws-3' });

    expect(manager.getPortalState('p1', 'ws-1')).toBeDefined();
    expect(manager.getPortalState('p2', 'ws-2')).toBeDefined();
    expect(manager.getPortalState('p3', 'ws-3')).toBeDefined();

    // Cria portal no 4º workspace -> ws-1 deve ser descartado
    manager.setActiveWorkspace('ws-4');
    manager.createPortal({ portalId: 'p4', workspaceId: 'ws-4' });

    expect(manager.getPortalState('p1', 'ws-1')).toBeNull();
    expect(manager.getPortalState('p2', 'ws-2')).toBeDefined();
    expect(manager.getPortalState('p3', 'ws-3')).toBeDefined();
    expect(manager.getPortalState('p4', 'ws-4')).toBeDefined();
  });

  it('alterna visibilidade ao abrir modal para não cobrir controles do app', () => {
    const { win } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});

    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1' });

    // Abre modal
    manager.setModalState(true);
    const stateWithModal = manager.getPortalState('p1', 'ws-1');
    expect(stateWithModal?.visible).toBe(false);

    // Fecha modal
    manager.setModalState(false);
    const stateWithoutModal = manager.getPortalState('p1', 'ws-1');
    expect(stateWithoutModal?.visible).toBe(true);
  });

  it('captures before hiding the live portal and keeps its full bounds while showing a snapshot', async () => {
    const { win, addedViews } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});
    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 100, y: 100, width: 800, height: 500 } });
    const view = addedViews[0] as any;
    view.setBounds.mockClear();
    const order: string[] = [];
    view.webContents.capturePage.mockImplementation(async () => { order.push('capture'); return { toDataURL: () => 'data:image/png;base64,snapshot' }; });
    view.setVisible.mockImplementation((visible: boolean) => { order.push(visible ? 'show' : 'hide'); });

    const snapshot = await manager.syncBounds({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 90, y: 100, width: 800, height: 500 }, visible: false });

    expect(snapshot).toBe('data:image/png;base64,snapshot');
    expect(order).toEqual(['capture', 'hide']);
    expect(view.setBounds).not.toHaveBeenCalled();

    await manager.syncBounds({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 50, y: 100, width: 800, height: 500 }, visible: true });
    expect(view.setBounds).toHaveBeenCalledWith({ x: 50, y: 100, width: 800, height: 500 });
    expect(order.at(-1)).toBe('show');
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
  });

  it('keeps tab views hidden while the portal presentation is a snapshot', async () => {
    const { win, addedViews } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});
    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 100, y: 100, width: 800, height: 500 } });
    await manager.syncBounds({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 100, y: 100, width: 800, height: 500 }, visible: false });

    manager.createTab('p1', 'https://example.com', 'ws-1');

    expect(addedViews).toHaveLength(2);
    expect((addedViews[1] as any).setVisible).toHaveBeenCalledWith(false);
    expect((addedViews[1] as any).setVisible).not.toHaveBeenCalledWith(true);
  });

  it('can refresh a snapshot without showing or resizing the hidden view', async () => {
    const { win, addedViews } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});
    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 100, y: 100, width: 800, height: 500 } });
    const view = addedViews[0] as any;
    await manager.syncBounds({ portalId: 'p1', workspaceId: 'ws-1', bounds: { x: 100, y: 100, width: 800, height: 500 }, visible: false });
    view.setBounds.mockClear();
    view.setVisible.mockClear();

    const snapshot = await manager.captureSnapshot('p1', 'ws-1');

    expect(snapshot).toBe('data:image/png;base64,snapshot');
    expect(view.setBounds).not.toHaveBeenCalled();
    expect(view.setVisible).not.toHaveBeenCalled();
  });

  it('destrói portal limpamente sem processos órfãos', () => {
    const { win, removedViews } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});

    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1' });

    expect(manager.getPortalState('p1', 'ws-1')).toBeDefined();

    manager.destroyPortal('p1', 'ws-1');
    expect(manager.getPortalState('p1', 'ws-1')).toBeNull();
    expect(removedViews).toHaveLength(1);
  });

  it('permite criar e alternar abas dentro do mesmo portal', () => {
    const { win } = createMockWindow();
    const manager = new PortalManager(() => win, () => {});

    manager.setActiveWorkspace('ws-1');
    manager.createPortal({ portalId: 'p1', workspaceId: 'ws-1' });

    const withNewTab = manager.createTab('p1', 'https://orquestra.dev', 'ws-1');
    expect(withNewTab?.tabs).toHaveLength(2);
    expect(withNewTab?.activeTabId).toContain('tab-');

    const firstTabId = withNewTab!.tabs[0]!.id;
    const switched = manager.switchTab('p1', firstTabId, 'ws-1');
    expect(switched?.activeTabId).toBe(firstTabId);
  });
});
