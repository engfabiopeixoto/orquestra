// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalNode } from '../src/renderer/src/portal/PortalNode';
import { createInMemoryPortalBridge, setPortalBridge } from '../src/renderer/src/portal/portal-bridge';
import { portalStore } from '../src/renderer/src/portal/portal-state';

// ResizeObserver mock para jsdom que permite simular redução do .canvas ao abrir/redimensionar o painel direito
const resizeObservers: Array<{ targets: Set<Element>; cb: ResizeObserverCallback }> = [];
global.ResizeObserver = class implements ResizeObserver {
  private readonly entry = { targets: new Set<Element>(), cb: (() => {}) as ResizeObserverCallback };
  constructor(cb: ResizeObserverCallback) {
    this.entry.cb = cb;
    resizeObservers.push(this.entry);
  }
  observe(target: Element) { this.entry.targets.add(target); }
  unobserve(target: Element) { this.entry.targets.delete(target); }
  disconnect() { this.entry.targets.clear(); }
};

beforeEach(() => {
  portalStore.setState({ portals: {} });
  setPortalBridge(createInMemoryPortalBridge());
});

afterEach(cleanup);

const createNodeProps = (id: string, name: string, initialUrl?: string) =>
  ({
    id,
    data: { name, initialUrl },
    selected: false,
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    type: 'portal',
    dragging: false,
    width: 800,
    height: 600,
  } as unknown as Parameters<typeof PortalNode>[0]);

describe('PortalNode', () => {
  it('renderiza o nó com input de URL e botões de navegação', async () => {
    render(
      <ReactFlowProvider>
        <PortalNode {...createNodeProps('portal-1', 'Portal Teste', 'https://duckduckgo.com')} />
      </ReactFlowProvider>,
    );

    const input = (await screen.findByTestId('portal-url-input')) as HTMLInputElement;
    expect(input.value).toBe('https://duckduckgo.com');
    expect(screen.getByTestId('portal-btn-back')).toBeTruthy();
    expect(screen.getByTestId('portal-btn-forward')).toBeTruthy();
    expect(screen.getByTestId('portal-btn-reload')).toBeTruthy();
    expect(screen.getByTestId('portal-mode-desktop')).toBeTruthy();
    expect(screen.getByTestId('portal-mode-mobile')).toBeTruthy();
  });

  it('permite alterar a URL e navegar', async () => {
    render(
      <ReactFlowProvider>
        <PortalNode {...createNodeProps('portal-1', 'Portal Teste', 'https://duckduckgo.com')} />
      </ReactFlowProvider>,
    );

    const input = (await screen.findByTestId('portal-url-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    expect(input.value).toBe('https://example.com');

    fireEvent.click(screen.getByTestId('portal-btn-go'));

    await waitFor(() => {
      const state = portalStore.getState().portals['portal-1'];
      expect(state?.tabs[0]?.url).toBe('https://example.com');
    });
  });

  it('alterna para modo mobile e exibe seletor de presets e botão de rotação', async () => {
    render(
      <ReactFlowProvider>
        <PortalNode {...createNodeProps('portal-1', 'Portal Teste')} />
      </ReactFlowProvider>,
    );

    const mobileBtn = await screen.findByTestId('portal-mode-mobile');
    fireEvent.click(mobileBtn);

    await waitFor(() => {
      expect(screen.getByTestId('portal-preset-select')).toBeTruthy();
      expect(screen.getByTestId('portal-btn-rotate')).toBeTruthy();
    });

    // Alterna rotação
    const rotateBtn = screen.getByTestId('portal-btn-rotate');
    fireEvent.click(rotateBtn);

    await waitFor(() => {
      const state = portalStore.getState().portals['portal-1'];
      expect(state?.orientation).toBe('landscape');
    });
  });

  it('adiciona novas abas ao clicar no botão +', async () => {
    render(
      <ReactFlowProvider>
        <PortalNode {...createNodeProps('portal-1', 'Portal Teste')} />
      </ReactFlowProvider>,
    );

    const addTabBtn = await screen.findByTestId('portal-new-tab');
    fireEvent.click(addTabBtn);

    await waitFor(() => {
      const state = portalStore.getState().portals['portal-1'];
      expect(state?.tabs.length).toBe(2);
    });
  });

  it('atualiza frameBounds quando o canvas encolhe ao abrir o painel à direita e oculta quando width fica zero', async () => {
    const baseBridge = createInMemoryPortalBridge();
    const syncCalls: Array<{ bounds: { x: number; width: number }; frameBounds: { x: number; width: number }; visible: boolean }> = [];
    setPortalBridge({
      ...baseBridge,
      syncBounds: async (payload) => {
        syncCalls.push({ bounds: payload.bounds, frameBounds: payload.frameBounds, visible: payload.visible });
        return baseBridge.syncBounds(payload);
      },
    });

    let canvasWidth = 1000;
    const canvas = document.createElement('main');
    canvas.className = 'canvas';
    canvas.getBoundingClientRect = () =>
      ({ left: 220, top: 32, right: 220 + canvasWidth, bottom: 800, width: canvasWidth, height: 768, x: 220, y: 32, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(canvas);

    try {
      render(
        <ReactFlowProvider>
          <PortalNode {...createNodeProps('portal-1', 'Portal Direito')} />
        </ReactFlowProvider>,
      );

      await waitFor(() => {
        expect(syncCalls.some((c) => c.frameBounds.width === 1000 && c.visible)).toBe(true);
      });

      // Painel de Qualidade abre/redimensiona para 320px à direita -> .canvas encolhe para 680px
      canvasWidth = 680;
      for (const ro of resizeObservers) {
        if (ro.targets.has(canvas)) {
          ro.cb([], {} as ResizeObserver);
        }
      }

      await waitFor(() => {
        expect(syncCalls.at(-1)?.frameBounds.width).toBe(680);
        expect(syncCalls.at(-1)?.visible).toBe(true);
      });

      // Janela muito estreita com painel aberto (canvas.width === 0) -> oculta o portal com o nó montado
      canvasWidth = 0;
      for (const ro of resizeObservers) {
        if (ro.targets.has(canvas)) {
          ro.cb([], {} as ResizeObserver);
        }
      }

      await waitFor(() => {
        expect(syncCalls.at(-1)?.frameBounds.width).toBe(0);
        expect(syncCalls.at(-1)?.visible).toBe(false);
      });
    } finally {
      canvas.remove();
    }
  });
});
