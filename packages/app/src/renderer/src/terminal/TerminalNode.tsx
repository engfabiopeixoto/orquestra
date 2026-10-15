import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { NodeResizer, NodeToolbar, Position, useReactFlow, useViewport, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCommandApi } from '../api';
import type { TerminalFlowNode } from '../canvas/flow-nodes';
import { ContextBar } from '../components/ContextBar';
import { NodeErrorBoundary } from '../components/NodeErrorBoundary';
import { focusTerminalRequest } from '../canvas/focus-terminal';
import { outputBus } from '../output-bus';
import { appStore, useApp } from '../store';
import { runAttachTerminal } from './attach';
import { terminalKeyAction } from './keys';
import { muteTerminalReplies } from './replies';
import { applyWheelScroll, forwardWheelToCanvas, forwardWheelToTerminal } from './wheel';
import { activeWorkspaceId } from '../workspace-context';
import { recoverGroupLayout } from '../groups/helpers';
import { NodeConnectors } from '../canvas/NodeConnectors';
import { TerminalFlowPorts } from '../flow/TerminalFlowPorts';
import { AGENT_FLOW_IO } from '../flow/feature-flags';

export type { TerminalFlowNode };

declare global {
  interface Window {
    __orqTerms?: Record<string, Terminal>;
  }
}

const api = createCommandApi(window.orquestra.invoke);
const STATE_LABEL = { starting: 'iniciando', idle: 'ocioso', busy: 'ocupado', waiting: 'aguardando você', exited: 'encerrado' } as const;
const RESIZE_DEBOUNCE_MS = 100;

/** Altura de uma linha em pixels de layout (não muda com o zoom do canvas). */
function cellHeightOf(term: Terminal): number {
  const screen = term.element?.querySelector('.xterm-screen');
  return screen && term.rows > 0 ? screen.clientHeight / term.rows : 0;
}

function TerminalBody({ name, readOnly }: { name: string; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const wheelState = useRef({ carry: 0 });
  const isFocused = useApp((state) => state.focusedTerminal === name);

  useEffect(() => {
    const workspaceId = activeWorkspaceId();
    const api = createCommandApi(window.orquestra.invoke, () => workspaceId);
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      allowProposedApi: true,
      theme: { background: '#161a21', foreground: '#d6dae2', cursor: '#f2a33a', selectionBackground: '#f2a33a55' },
    });
    termRef.current = term;
    muteTerminalReplies(term);
    // Só nos testes de ponta a ponta: deixa o teste ler o que a interface desenhou.
    if (window.orquestra.testProject) (window.__orqTerms ??= {})[name] = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // Sem WebGL o xterm usa o renderizador DOM (mais lento, mas funcional).
    }
    const copySelection = () => {
      void window.orquestra.writeClipboard(term.getSelection());
      term.clearSelection();
    };
    // term.paste usa colagem delimitada quando o agente pede: o texto chega como colagem, não como digitação.
    const pasteClipboard = () => { if (!readOnlyRef.current) void window.orquestra.readClipboard().then((text) => { if (!readOnlyRef.current) term.paste(text); }); };
    term.attachCustomKeyEventHandler((event) => {
      const action = terminalKeyAction(event, term.hasSelection());
      if (action === 'pass') return true;
      // Sem isto o navegador dispararia a própria colagem e o texto chegaria duas vezes.
      event.preventDefault();
      if (action === 'copy') copySelection();
      else pasteClipboard();
      return false;
    });
    // Clique direito, como no Windows Terminal: copia a seleção ou, sem seleção, cola.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) copySelection();
      else pasteClipboard();
    };
    host.current!.addEventListener('contextmenu', onContextMenu);
    // Em captura, antes do xterm: rola o buffer direto e não perde a roda para a saída que chega junto.
    const hostElement = host.current!;
    const onWheel = (event: WheelEvent) => {
      // Ctrl+roda é zoom do canvas em qualquer zoom: nunca rola o histórico nem chega ao agente.
      if (forwardWheelToCanvas(event, hostElement.closest('.term-node'))) return;
      applyWheelScroll(term, event, cellHeightOf(term), wheelState.current);
    };
    hostElement.addEventListener('wheel', onWheel, { capture: true, passive: false });
    const onFocus = () => appStore.getState().setFocus(name);
    const onBlur = () => {
      if (workspaceId !== activeWorkspaceId()) return;
      if (readOnlyRef.current) return;
      if (appStore.getState().focusedTerminal === name) appStore.getState().setFocus(null);
    };
    term.textarea?.addEventListener('focus', onFocus);
    term.textarea?.addEventListener('blur', onBlur);

    const detach = runAttachTerminal({
      name,
      term,
      fit: () => fit.fit(),
      api,
      bus: outputBus,
      onError: (message) => appStore.getState().notify('error', message),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fit.fit();
        void api.command('terminal.resize', { name, cols: term.cols, rows: term.rows }).catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host.current!);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      detach();
      term.textarea?.removeEventListener('focus', onFocus);
      term.textarea?.removeEventListener('blur', onBlur);
      host.current?.removeEventListener('contextmenu', onContextMenu);
      hostElement.removeEventListener('wheel', onWheel, { capture: true });
      if (window.__orqTerms?.[name] === term) delete window.__orqTerms[name];
      term.dispose();
    };
  }, [name]);

  // A camada de zoom (.term-readonly) é irmã do corpo: ela escuta a roda no nó para repassá-la ao xterm.
  useEffect(() => {
    const node = host.current?.closest('.term-node');
    if (!node) return;
    const onWheel = (event: Event) => {
      if (!(event.target as Element).closest('.term-readonly')) return;
      const term = termRef.current;
      if (!term) return;
      if (applyWheelScroll(term, event as WheelEvent, cellHeightOf(term), wheelState.current)) return;
      forwardWheelToTerminal(term, term.element ?? null, event as WheelEvent);
    };
    // passive: false, senão o preventDefault é ignorado e a página ainda rola.
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = readOnly;
    if (!readOnly && isFocused) {
      termRef.current?.focus();
    }
  }, [readOnly, isFocused]);

  return <div ref={host} className="term-body nodrag nowheel nopan" data-testid={`terminal-body-${name}`} />;
}

export function TerminalNode({ id, data, selected }: NodeProps<TerminalFlowNode>) {
  const view = useApp((state) => state.terminals[data.name]);
  const { zoom } = useViewport();
  const { getNode, setCenter } = useReactFlow();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [menu]);
  const zoomReadOnly = Math.abs(zoom - 1) > 0.001;
  const readOnly = zoomReadOnly || Boolean(view?.blurred) || view?.state === 'exited';
  if (!view) return null;
  const openMenu = (x: number, y: number) => setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 230)), y: Math.max(8, Math.min(y, window.innerHeight - 360)) });
  const openFromButton = (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.right - 220, rect.bottom + 4); };
  const reload = async () => {
    try { appStore.getState().replaceTerminal(data.name, await api.command('terminal.restart', { name: data.name })); }
    catch (error) { appStore.getState().notify('error', (error as Error).message); }
  };

  const focusAtFullZoom = () => {
    focusTerminalRequest(data.name, {
      getNode,
      setCenter,
      setFocus: (focus) => appStore.getState().setFocus(focus),
      sizeOf: (terminal) => appStore.getState().terminals[terminal]?.size,
    });
  };

  return (
    <div className={`term-node frame-${view.state} ${selected ? 'is-selected' : ''} ${view.locked ? 'is-locked nopan' : ''}`}>
      {view.state === 'waiting' ? <span className="waiting-badge" data-testid={`terminal-waiting-${data.name}`}>👋 aguardando você</span> : null}
      <NodeToolbar isVisible={selected && !menu} position={Position.Top} align="start">
        <ContextBar name={data.name} onOpenMenu={openFromButton} />
      </NodeToolbar>
      <NodeResizer
        isVisible={selected && !view.locked}
        minWidth={320}
        minHeight={180}
        onResizeEnd={(_event, params) => {
          appStore.getState().resizeNode(data.name, { width: params.width, height: params.height });
          appStore.getState().moveNode(data.name, { x: params.x, y: params.y });
          void api
            .command('layout.update', {
              nodes: [{ name: data.name, x: params.x, y: params.y, width: params.width, height: params.height }],
            })
            .catch((error) => recoverGroupLayout(api, error));
        }}
      />
      <NodeConnectors />
      <header className="term-hd" data-testid={`terminal-header-${data.name}`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY); }}>
        <span className="term-name">{view.name}</span>
        <span className="chip">{view.agent}</span>
        {view.regente ? <span className="chip regente" data-testid={`terminal-regente-${view.name}`}>regente</span> : null}
        {view.locked ? <span className="chip" title="Posição bloqueada">🔒</span> : null}
        <span className={`term-state st-${view.state}`} data-testid={`terminal-state-${data.name}`}>
          <span className="dot" />
          {view.unloaded ? 'descarregado' : STATE_LABEL[view.state]}
          {view.queued > 0 ? ` · ${view.queued} na fila` : ''}
        </span>
        <button className="term-options nodrag nopan" aria-label={`Opções de ${view.name}`} data-testid={`terminal-options-${view.name}`} onClick={openFromButton}>⋯</button>
      </header>
      {view.notice ? <div className="term-notice">{view.notice}</div> : null}
      {AGENT_FLOW_IO ? <TerminalFlowPorts name={data.name} /> : null}
      <div className="term-display">
        {view.unloaded ? <div className="terminal-unloaded nodrag nopan" data-testid={`terminal-unloaded-${data.name}`}><span>Agente parado</span><button onClick={() => void reload()}>Recarregar terminal</button></div> : <>
          <div className={view.blurred ? 'term-content is-blurred' : 'term-content'}><NodeErrorBoundary name={data.name}><TerminalBody key={view.epoch} name={data.name} readOnly={readOnly} /></NodeErrorBoundary></div>
          {view.blurred ? <div className="terminal-privacy nodrag nopan"><span>Conteúdo desfocado</span><button onClick={() => void api.command('terminal.presentation', { name: data.name, blurred: false }).then(() => appStore.getState().setTerminalPresentation(data.name, { blurred: false })).catch((error: Error) => appStore.getState().notify('error', error.message))}>Mostrar conteúdo</button></div> : null}
        </>}
      </div>
      {zoomReadOnly && !view.blurred && !view.unloaded ? (
        <div className="term-readonly nodrag" style={{ zIndex: 10 }} onDoubleClick={focusAtFullZoom}>
          duplo clique para interagir
        </div>
      ) : null}
      {menu ? createPortal(<div ref={menuRef} className="terminal-menu nodrag nopan" role="menu" aria-label={`Opções de ${view.name}`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <ContextBar name={data.name} menu onDone={() => setMenu(null)} />
      </div>, document.body) : null}
    </div>
  );
}
