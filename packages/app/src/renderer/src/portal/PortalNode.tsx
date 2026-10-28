import { Handle, Position, NodeResizer, useReactFlow, useViewport, type Node, type NodeProps } from '@xyflow/react';
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
import { portalNodeBounds, portalPresentation, type PortalRect } from './portal-presentation';
import './portal.css';
import { appStore, useApp } from '../store';
import { focusTerminalRequest } from '../canvas/focus-terminal';

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
  const { getNode, setCenter, setNodes } = useReactFlow();
  const connectedAgents = useApp((state) => state.edges.filter((edge) => edge.a === id && state.terminals[edge.b] || edge.b === id && state.terminals[edge.a]).length);

  const [inputUrl, setInputUrl] = useState(data?.initialUrl ?? 'https://duckduckgo.com');
  const urlDirty = useRef(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [liveView, setLiveView] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState('');
  const viewContainerRef = useRef<HTMLDivElement>(null);
  const lastGeometryRef = useRef('');
  const lastMotionAtRef = useRef(0);
  const presentationRef = useRef<'live' | 'snapshot' | null>(null);
  const lastBoundsRef = useRef('');
  const syncSequenceRef = useRef(0);

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

    const refreshSnapshot = () => {
      if (unmounted || presentationRef.current !== 'snapshot') return;
      const request = ++syncSequenceRef.current;
      void bridge.captureSnapshot(id, workspaceId).then((image) => {
        if (!unmounted && image && request === syncSequenceRef.current && presentationRef.current === 'snapshot') setSnapshot(image);
      }).catch((captureError: Error) => { if (!unmounted) setError(captureError.message); });
    };

    const unsubscribeEvents = bridge.onEvent((event) => {
      if (event.portalId !== id) return;
      if (event.type === 'portal:loading') {
        portalStore.getState().updateTab(id, event.tabId, { isLoading: event.isLoading });
        if (!event.isLoading) refreshSnapshot();
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
        refreshSnapshot();
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

  // Mantém bounds lógicos completos e alterna entre WebContentsView e snapshot DOM.
  useEffect(() => {
    if (!nativeReady) return;
    const el = viewContainerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let settleTimer: number | null = null;
    const sync = () => {
      if (!viewContainerRef.current) return;
      const containerRect = viewContainerRef.current.getBoundingClientRect();
      const nodeRect: PortalRect = { left: containerRect.left, top: containerRect.top, right: containerRect.right, bottom: containerRect.bottom };
      const canvasEl = document.querySelector('.canvas');
      const canvasRect = canvasEl
        ? canvasEl.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const visibleRect: PortalRect = { left: canvasRect.left, top: canvasRect.top, right: canvasRect.right, bottom: canvasRect.bottom };
      const overlays = document.querySelectorAll<HTMLElement>(
        '.side, .palette, .group-tools, .flow-toolbar, .zoom, .subscription-usage, .ctx-menu, .terminal-menu, .dialog-backdrop, [role="dialog"], [role="menu"]',
      );
      const overlapped = [...overlays].some((overlay) => {
        if (overlay === el || el.contains(overlay)) return false;
        const rect = overlay.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left < nodeRect.right && rect.right > nodeRect.left && rect.top < nodeRect.bottom && rect.bottom > nodeRect.top;
      });

      const bounds = portalNodeBounds(nodeRect);
      const boundsKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      const geometryKey = `${boundsKey}:${viewport.zoom}`;
      const now = performance.now();
      if (lastGeometryRef.current && geometryKey !== lastGeometryRef.current) lastMotionAtRef.current = now;
      lastGeometryRef.current = geometryKey;
      const moving = now - lastMotionAtRef.current < 150;
      const nextPresentation = portalPresentation({ nodeRect, visibleRect, zoom: viewport.zoom, overlapped, moving });
      const presentationChanged = presentationRef.current !== nextPresentation;
      const boundsChanged = lastBoundsRef.current !== boundsKey;

      if ((nextPresentation === 'live' && (presentationChanged || boundsChanged)) || (nextPresentation === 'snapshot' && presentationChanged)) {
        presentationRef.current = nextPresentation;
        if (nextPresentation === 'live') lastBoundsRef.current = boundsKey;
        const request = ++syncSequenceRef.current;
        void bridge.syncBounds({ portalId: id, workspaceId, bounds, visible: nextPresentation === 'live' }).then((image) => {
          if (request !== syncSequenceRef.current) return;
          if (nextPresentation === 'snapshot') {
            if (image) setSnapshot(image);
            setLiveView(false);
          } else {
            setLiveView(true);
          }
        }).catch((syncError: Error) => setError(syncError.message));
      }

      if (settleTimer !== null) window.clearTimeout(settleTimer);
      const settleIn = 150 - (performance.now() - lastMotionAtRef.current);
      if (settleIn > 0) settleTimer = window.setTimeout(sync, settleIn + 1);
    };

    const observer = new ResizeObserver(() => sync());
    observer.observe(el);

    // Sincroniza em animações de scroll/zoom e movimentação do canvas
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    sync();

    // Durante movimento, mede uma vez por frame; no modo snapshot não envia bounds ao main.
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
      if (settleTimer !== null) window.clearTimeout(settleTimer);
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

  const zoomReadOnly = Math.abs(viewport.zoom - 1) > 0.001;
  const focusAtFullZoom = () => {
    const focused = focusTerminalRequest(id, {
      getNode,
      setCenter,
      setFocus: () => {},
      sizeOf: () => portal?.size ?? { width: 800, height: 600 },
    });
    if (focused) {
      setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, selected: false } : node));
      appStore.setState((state) => ({ selectedNodes: state.selectedNodes.filter((name) => name !== id) }));
    }
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
        {liveView ? (
          <div className="portal-view-placeholder" aria-hidden="true"><span>Portal Web Ativo</span></div>
        ) : (
          <div
            className={`portal-snapshot ${zoomReadOnly ? 'is-zoomed nodrag' : ''}`}
            data-testid={`portal-snapshot-${id}`}
            onPointerDown={zoomReadOnly ? (event) => event.stopPropagation() : undefined}
            onDoubleClick={zoomReadOnly ? focusAtFullZoom : undefined}
          >
            {snapshot ? <img src={snapshot} alt="" draggable={false} data-testid={`portal-snapshot-image-${id}`} /> : (
              <div className="portal-view-placeholder">
                <span>{activeTab?.title || 'Portal pronto'}</span>
                <small>{activeTab?.url || inputUrl}</small>
              </div>
            )}
            {zoomReadOnly ? <div className="portal-live-hint" data-testid={`portal-live-hint-${id}`}>duplo clique para interagir</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
