import { Handle, Position, NodeResizer, useViewport, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ALL_PRESETS,
  MOBILE_PRESETS,
  MAX_TABS_PER_PORTAL,
  getDevicePreset,
  rotateDimensions,
  type PortalMode,
  type PortalOrientation,
  type PortalState,
  type PortalTab,
} from '../../../shared/portal-protocol';
import { activeWorkspaceId } from '../workspace-context';
import { getPortalBridge } from './portal-bridge';
import { portalStore, usePortalStore } from './portal-state';
import './portal.css';
import { useApp } from '../store';

export interface PortalNodeData {
  name: string;
  initialUrl?: string;
  mode?: PortalMode;
  presetId?: string;
  orientation?: PortalOrientation;
  onRemove?(name: string): void;
}

export type PortalFlowNode = Node<{ name: string; initialUrl?: string }, 'portal'>;

export function PortalNode({ id, data, selected }: NodeProps<PortalFlowNode>) {
  const workspaceId = activeWorkspaceId() || 'default';
  const bridge = getPortalBridge();
  const portal = usePortalStore((state) => state.portals[id]);
  const viewport = useViewport();
  const connectedAgents = useApp((state) => state.edges.filter((edge) => edge.a === id && state.terminals[edge.b] || edge.b === id && state.terminals[edge.a]).length);

  const [inputUrl, setInputUrl] = useState(data?.initialUrl ?? 'https://duckduckgo.com');
  const urlDirty = useRef(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [error, setError] = useState('');
  const viewContainerRef = useRef<HTMLDivElement>(null);

  // Inicializa o portal no main process e na store se não existir
  useEffect(() => {
    let unmounted = false;

    async function init() {
      const existing = await bridge.getState(id, workspaceId);
      if (unmounted) return;
      if (existing) {
        portalStore.getState().setPortal(existing);
        const active = existing.tabs.find((t) => t.id === existing.activeTabId);
        if (active && !urlDirty.current) setInputUrl(active.url);
        setNativeReady(true);
      } else {
        const saved = portalStore.getState().portals[id];
        const created = await bridge.create({
          portalId: id,
          workspaceId,
          initialUrl: saved?.tabs.find((tab) => tab.id === saved.activeTabId)?.url ?? data.initialUrl ?? 'https://duckduckgo.com',
          mode: saved?.mode ?? 'desktop',
          presetId: saved?.presetId ?? 'desktop-compact',
          orientation: saved?.orientation ?? 'portrait',
          tabs: saved?.tabs,
          activeTabId: saved?.activeTabId,
        });
        if (!unmounted) {
          portalStore.getState().setPortal(created);
          setNativeReady(true);
        }
      }
    }

    void init().catch((error) => { if (!unmounted) setError((error as Error).message); });

    const unsubscribeEvents = bridge.onEvent((event) => {
      if (event.portalId !== id) return;
      if (event.type === 'portal:loading') {
        portalStore.getState().updateTab(id, event.tabId, { isLoading: event.isLoading });
      } else if (event.type === 'portal:navigated') {
        setError('');
        portalStore.getState().updateTab(id, event.tabId, {
          url: event.url,
          canGoBack: event.canGoBack,
          canGoForward: event.canGoForward,
        });
        const currentActive = portalStore.getState().portals[id]?.activeTabId;
        if (currentActive === event.tabId && !urlDirty.current) {
          setInputUrl(event.url);
        }
      } else if (event.type === 'portal:title') {
        portalStore.getState().updateTab(id, event.tabId, { title: event.title });
      } else if (event.type === 'portal:favicon') {
        portalStore.getState().updateTab(id, event.tabId, { favicon: event.favicon });
      } else if (event.type === 'portal:error') {
        setError(event.error);
      }
    });

    return () => {
      unmounted = true;
      unsubscribeEvents();
      void bridge.syncBounds({ portalId: id, workspaceId, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }).catch(() => {});
    };
  }, [id, workspaceId]);

  // Sincroniza coordenadas (bounds) e recorta contra a área útil do canvas (não cobrir sidebar ou toolbars)
  useEffect(() => {
    if (!nativeReady) return;
    const el = viewContainerRef.current;
    if (!el) return;

    let previousBounds = '';
    const sync = () => {
      if (!viewContainerRef.current) return;
      const containerRect = viewContainerRef.current.getBoundingClientRect();

      // Encontra a área real do canvas para clipping
      const canvasEl = document.querySelector('.canvas');
      const canvasRect = canvasEl
        ? canvasEl.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

      const clipLeft = Math.max(containerRect.left, canvasRect.left);
      let clipTop = Math.max(containerRect.top, canvasRect.top);
      const clipRight = Math.min(containerRect.right, canvasRect.right);
      let clipBottom = Math.min(containerRect.bottom, canvasRect.bottom);
      for (const selector of ['.palette', '.group-tools', '.flow-toolbar', '.zoom-control', '.subscription-usage']) {
        const control = document.querySelector(selector)?.getBoundingClientRect();
        if (!control || control.right <= clipLeft || control.left >= clipRight || control.bottom <= clipTop || control.top >= clipBottom) continue;
        if (control.top > containerRect.top + containerRect.height / 2) clipBottom = Math.min(clipBottom, control.top - 4);
        else clipTop = Math.max(clipTop, control.bottom + 4);
      }

      const isVisible =
        clipRight > clipLeft &&
        clipBottom > clipTop &&
        containerRect.width > 0 &&
        containerRect.height > 0;
      const clippedWidth = Math.max(0, clipRight - clipLeft);
      const clippedHeight = Math.max(0, clipBottom - clipTop);

      const key = `${clipLeft}:${clipTop}:${clippedWidth}:${clippedHeight}:${isVisible}`;
      if (key === previousBounds) return;
      previousBounds = key;
      void bridge.syncBounds({
        portalId: id,
        workspaceId,
        bounds: {
          x: clipLeft,
          y: clipTop,
          width: isVisible ? clippedWidth : 0,
          height: isVisible ? clippedHeight : 0,
        },
        visible: isVisible,
      });
    };

    const observer = new ResizeObserver(() => sync());
    observer.observe(el);

    // Sincroniza em animações de scroll/zoom e movimentação do canvas
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    sync();

    // Loop contínuo durante arrasto ou animação
    let rafId: number | null = null;
    const onMove = () => {
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          sync();
          rafId = null;
        });
      }
    };
    window.addEventListener('pointermove', onMove);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
      window.removeEventListener('pointermove', onMove);
    };
  }, [id, workspaceId, nativeReady, portal?.mode, portal?.orientation, portal?.presetId, portal?.size?.width, portal?.size?.height, viewport.x, viewport.y, viewport.zoom]);

  const activeTab = portal?.tabs.find((t: PortalTab) => t.id === portal.activeTabId) ?? portal?.tabs[0];
  const isHttps = activeTab?.url.startsWith('https://');

  const handleNavigate = () => {
    if (!inputUrl.trim()) return;
    setError('');
    urlDirty.current = false;
    void bridge.navigate(id, inputUrl, workspaceId).catch((error) => setError((error as Error).message));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNavigate();
    }
  };

  const handleModeChange = (mode: PortalMode) => {
    const presetId = mode === 'mobile' ? 'iphone-15-pro' : 'desktop-compact';
    void bridge.setMode(id, mode, presetId, portal?.orientation ?? 'portrait', workspaceId).then((updated) => {
      if (updated) portalStore.getState().setPortal(updated);
    });
  };

  const handlePresetChange = (presetId: string) => {
    void bridge.setMode(id, 'mobile', presetId, portal?.orientation ?? 'portrait', workspaceId).then((updated) => {
      if (updated) portalStore.getState().setPortal(updated);
    });
  };

  const handleToggleOrientation = () => {
    const next: PortalOrientation = portal?.orientation === 'landscape' ? 'portrait' : 'landscape';
    void bridge.setMode(id, portal?.mode ?? 'mobile', portal?.presetId, next, workspaceId).then((updated) => {
      if (updated) portalStore.getState().setPortal(updated);
    });
  };

  const handleAddTab = () => {
    void bridge.createTab(id, 'about:blank', workspaceId).then((updated) => {
      if (updated) { portalStore.getState().setPortal(updated); urlDirty.current = false; setInputUrl(updated.tabs.find((tab) => tab.id === updated.activeTabId)?.url ?? 'about:blank'); }
    });
  };

  const handleSwitchTab = (tabId: string) => {
    void bridge.switchTab(id, tabId, workspaceId).then((updated) => {
      if (updated) {
        portalStore.getState().setPortal(updated);
        const t = updated.tabs.find((tab: PortalTab) => tab.id === tabId);
        urlDirty.current = false;
        if (t) setInputUrl(t.url);
      }
    });
  };

  const handleCloseTab = (tabId: string) => {
    void bridge.closeTab(id, tabId, workspaceId).then((updated) => {
      if (updated) portalStore.getState().setPortal(updated);
    });
  };

  const handleClosePortal = () => {
    void bridge.destroy(id, workspaceId);
    portalStore.getState().removePortal(id);
    ((data as unknown as PortalNodeData)?.onRemove)?.(id);
  };

  // Se estiver no modo mobile, define dimensões proporcionais sugeridas no container
  const activePreset = getDevicePreset(portal?.presetId ?? 'desktop-compact');
  const isMobile = portal?.mode === 'mobile';
  const mobileDims = isMobile
    ? rotateDimensions(activePreset.width, activePreset.height, portal?.orientation ?? 'portrait')
    : null;

  return (
    <div
      className={`portal-node ${selected ? 'is-selected' : ''} ${isMobile ? 'is-mobile-frame' : ''}`}
      style={{
        width: mobileDims ? mobileDims.width + 16 : portal?.size?.width ?? 800,
        height: mobileDims ? mobileDims.height + 120 : portal?.size?.height ?? 600,
      }}
      data-testid={`portal-node-${id}`}
    >
      <Handle type="target" position={Position.Left} id="left" style={{ top: 36 }} title="Conectar agente ao navegador" />
      <Handle type="source" position={Position.Right} id="right" style={{ top: 36 }} title="Conectar navegador ao agente" />
      {!isMobile && (
        <NodeResizer
          isVisible={selected}
          minWidth={360}
          minHeight={260}
          lineClassName="border-acc"
          handleClassName="bg-acc"
          onResizeEnd={(_event, rect) => portalStore.getState().updatePortal(id, { position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } })}
        />
      )}

      {/* Barra Superior / Controles */}
      <div className="portal-header">
        <small className="portal-agent-status" data-testid="portal-agent-status" title={`Identificador para os agentes: ${id}`}>{connectedAgents ? `${connectedAgents} ${connectedAgents === 1 ? 'agente conectado' : 'agentes conectados'}` : 'Conecte um agente pelas portas laterais'}</small>
        {error ? <div className="usage-error" role="alert" title={error}>{error.slice(0, 240)}</div> : null}
        {/* Abas */}
        <div className="portal-top-row">
          <div className="portal-tabs-list">
            {(portal?.tabs ?? []).map((tab: PortalTab) => (
              <div
                key={tab.id}
                className={`portal-tab-item ${tab.id === portal?.activeTabId ? 'is-active' : ''}`}
                onClick={() => handleSwitchTab(tab.id)}
                title={tab.title || tab.url}
              >
                <span className="portal-tab-title">{tab.title || 'Aba'}</span>
                {portal && portal.tabs.length > 1 && (
                  <button
                    type="button"
                    className="portal-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(tab.id);
                    }}
                    title="Fechar aba"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="portal-tab-add"
              disabled={(portal?.tabs.length ?? 0) >= MAX_TABS_PER_PORTAL}
              onClick={handleAddTab}
              title="Nova aba"
              data-testid="portal-new-tab"
            >
              +
            </button>
          </div>

          <button
            type="button"
            className="portal-btn-icon"
            onClick={handleClosePortal}
            title="Fechar Portal"
            data-testid="portal-close"
          >
            ×
          </button>
        </div>

        {/* Linha de navegação (Back, Forward, Reload, URL) */}
        <div className="portal-nav-bar nodrag">
          <button
            type="button"
            className="portal-btn-icon"
            onClick={() => bridge.action(id, 'back', workspaceId)}
            title="Voltar"
            data-testid="portal-btn-back"
          >
            ◀
          </button>
          <button
            type="button"
            className="portal-btn-icon"
            onClick={() => bridge.action(id, 'forward', workspaceId)}
            title="Avançar"
            data-testid="portal-btn-forward"
          >
            ▶
          </button>
          <button
            type="button"
            className="portal-btn-icon"
            onClick={() => bridge.action(id, activeTab?.isLoading ? 'stop' : 'reload', workspaceId)}
            title={activeTab?.isLoading ? 'Parar' : 'Recarregar'}
            data-testid="portal-btn-reload"
          >
            {activeTab?.isLoading ? '✕' : '↻'}
          </button>

          <div className="portal-url-field">
            <span
              className={`portal-security-badge ${isHttps ? '' : 'is-insecure'}`}
              title={isHttps ? 'Conexão segura (HTTPS)' : 'Não seguro'}
            >
              {isHttps ? '🔒' : '🌐'}
            </span>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => { urlDirty.current = true; setInputUrl(e.target.value); }}
              onKeyDown={handleKeyDown}
              placeholder="Digite uma URL ou busque..."
              data-testid="portal-url-input"
            />
          </div>

          <button
            type="button"
            className="portal-btn-icon"
            onClick={handleNavigate}
            title="Ir para URL"
            data-testid="portal-btn-go"
          >
            ➔
          </button>
        </div>

        {/* Linha de modos: Desktop vs Mobile, Presets e Rotação */}
        <div className="portal-controls-row nodrag">
          <div className="portal-mode-toggle">
            <button
              type="button"
              className={`portal-mode-btn ${!isMobile ? 'is-active' : ''}`}
              onClick={() => handleModeChange('desktop')}
              data-testid="portal-mode-desktop"
            >
              Desktop
            </button>
            <button
              type="button"
              className={`portal-mode-btn ${isMobile ? 'is-active' : ''}`}
              onClick={() => handleModeChange('mobile')}
              data-testid="portal-mode-mobile"
            >
              📱 Mobile
            </button>
          </div>

          {isMobile && (
            <div className="portal-mobile-settings">
              <select
                className="portal-select"
                value={portal?.presetId ?? 'iphone-15-pro'}
                onChange={(e) => handlePresetChange(e.target.value)}
                data-testid="portal-preset-select"
              >
                {MOBILE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="portal-btn-icon"
                onClick={handleToggleOrientation}
                title={`Alternar orientação (${portal?.orientation === 'landscape' ? 'Paisagem' : 'Retrato'})`}
                data-testid="portal-btn-rotate"
              >
                🔄
              </button>
            </div>
          )}
        </div>
      </div>

      {isMobile && <div className="portal-notch" />}

      {/* Container visual da WebContentsView */}
      <div
        ref={viewContainerRef}
        className="portal-view-container nowheel nodrag"
        data-testid={`portal-view-container-${id}`}
      >
        <div className="portal-view-placeholder">
          <span>{activeTab?.isLoading ? 'Carregando página...' : 'Portal Web Ativo'}</span>
          <small>{activeTab?.url}</small>
        </div>
      </div>
    </div>
  );
}
