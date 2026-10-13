import { describe, expect, it } from 'vitest';
import { buildFlowNodes, type CanvasFlowNode } from '../src/renderer/src/canvas/flow-nodes';
import { createAppStore } from '../src/renderer/src/store';

const info = (name: string) => ({ name, agent: 'shell', state: 'starting' as const, queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: false });

describe('buildFlowNodes', () => {
  it('buildFlowNodes preserva posição durante arrasto quando chega evento de estado', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    const initialNodes = buildFlowNodes(store.getState().terminals, {});
    expect(initialNodes[0]?.position).toEqual({ x: 80, y: 80 });

    const draggingNodes: CanvasFlowNode[] = [{ ...initialNodes[0]!, position: { x: 300, y: 400 }, dragging: true }];
    store.getState().applyEvent({ type: 'terminal.state', name: 'A', state: 'busy', queued: 1 });

    const updatedNodes = buildFlowNodes(store.getState().terminals, {}, draggingNodes);
    expect(updatedNodes[0]?.position).toEqual({ x: 300, y: 400 });
  });

  it('buildFlowNodes preserva tamanho e posição durante redimensionamento quando chega evento de estado', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    const initialNodes = buildFlowNodes(store.getState().terminals, {});

    const resizingNodes: CanvasFlowNode[] = [
      { ...initialNodes[0]!, position: { x: 100, y: 120 }, style: { width: 800, height: 500 }, resizing: true },
    ];
    store.getState().applyEvent({ type: 'terminal.state', name: 'A', state: 'busy', queued: 1 });

    const updatedNodes = buildFlowNodes(store.getState().terminals, {}, resizingNodes);
    expect(updatedNodes[0]?.position).toEqual({ x: 100, y: 120 });
    expect(updatedNodes[0]?.style).toEqual({ width: 800, height: 500 });
  });

  it('buildFlowNodes mantém nó selecionado após renomear', () => {
    const store = createAppStore();
    store.getState().addTerminal(info('A'));
    const initialNodes = buildFlowNodes(store.getState().terminals, {});
    const selectedNodes: CanvasFlowNode[] = [{ ...initialNodes[0]!, selected: true }];

    store.getState().replaceTerminal('A', info('B'));

    const updatedNodes = buildFlowNodes(store.getState().terminals, {}, selectedNodes);
    expect(updatedNodes[0]?.id).toBe('B');
    expect(updatedNodes[0]?.selected).toBe(true);
  });

  it('monta nós de nota com tipo note, posição e tamanho', () => {
    const notes = { plano: { name: 'plano', content: '', revision: 1, updatedBy: 'você', position: { x: 5, y: 6 }, size: { width: 320, height: 240 }, conflict: null } };
    const [node] = buildFlowNodes({}, notes, []);
    expect(node).toMatchObject({ id: 'plano', type: 'note', position: { x: 5, y: 6 }, style: { width: 320, height: 240 }, data: { name: 'plano' } });
  });
});
