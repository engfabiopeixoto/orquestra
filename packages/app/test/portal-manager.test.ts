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
