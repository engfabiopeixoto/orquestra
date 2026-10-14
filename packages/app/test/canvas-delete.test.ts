// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

import type { Edge } from '@xyflow/react';
import type { CommandApi } from '../src/renderer/src/api';
import { filterEdgesToDelete, handleCanvasDelete, type CanvasDeleteParams } from '../src/renderer/src/canvas/Canvas';
import type { CanvasFlowNode } from '../src/renderer/src/canvas/flow-nodes';
import { appStore } from '../src/renderer/src/store';

function fakeApi(impl?: (method: string, params: unknown) => unknown): { api: CommandApi; command: ReturnType<typeof vi.fn> } {
  const command = vi.fn(async (method: string, params: unknown) => (impl ? impl(method, params) : {}));
  return { api: { command } as unknown as CommandApi, command };
}

describe('filterEdgesToDelete', () => {
  it('omite arestas que vêm junto com nó excluído', () => {
    const edges: Edge[] = [
      { id: 'S--T', source: 'S', target: 'T', selected: false },
      { id: 'T--U', source: 'T', target: 'U', selected: true },
    ];
    const nodes = [{ id: 'T' }];
    expect(filterEdgesToDelete(edges, nodes)).toEqual([]);
  });

  it('mantém arestas selecionadas diretamente sem nó excluído associado', () => {
    const edges: Edge[] = [
      { id: 'S--T', source: 'S', target: 'T', selected: true },
      { id: 'A--B', source: 'A', target: 'B', selected: false },
    ];
    expect(filterEdgesToDelete(edges, [])).toEqual([edges[0]]);
  });

  it('reconhece seleção pelo selectedEdgeIds se a aresta não tiver selected no objeto', () => {
    const edges: Edge[] = [
      { id: 'S--T', source: 'S', target: 'T', selected: false },
    ];
    expect(filterEdgesToDelete(edges, [], new Set(['S--T']))).toEqual([edges[0]]);
  });
});

describe('remoção no canvas (onBeforeDelete)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    appStore.setState({
      edges: [{ a: 'S', b: 'T' }],
      terminals: {
        S: { id: 's1', name: 'S', agent: 'shell', state: 'idle', queued: 0, cwd: 'C:/p', resume: false, args: [], regente: false, monitor: false },
        T: { id: 't1', name: 'T', agent: 'shell', state: 'idle', queued: 0, cwd: 'C:/p', resume: false, args: [], regente: false, monitor: false },
      },
      notes: {
        N: { id: 'n1', name: 'N', content: 'texto', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, revision: 1, updatedBy: 'user' },
      },
      notices: [],
    } as never);
  });

  it('nó com remoção cancelada mantém as arestas', async () => {
    const { api, command } = fakeApi();
    const onRemoveRequest = vi.fn();
    const deletedNodes: CanvasFlowNode[] = [
      { id: 'T', type: 'terminal', data: { name: 'T' }, position: { x: 0, y: 0 } } as CanvasFlowNode,
    ];
    // O React Flow inclui no deletedEdges as arestas ligadas ao nó removido
    const deletedEdges: Edge[] = [
      { id: 'S--T', source: 'S', target: 'T', selected: false },
    ];

    await handleCanvasDelete({
      deletedNodes,
      deletedEdges,
      api,
      onRemoveRequest,
    });

    expect(onRemoveRequest).toHaveBeenCalledWith('T');
    expect(command).not.toHaveBeenCalledWith('edge.disconnect', expect.anything());
    expect(appStore.getState().edges).toEqual([{ a: 'S', b: 'T' }]);
  });

  it('nota com remoção cancelada mantém a nota e as arestas', async () => {
    appStore.setState({ edges: [{ a: 'S', b: 'N' }] } as never);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { api, command } = fakeApi();
    const onRemoveRequest = vi.fn();
    const deletedNodes: CanvasFlowNode[] = [
      { id: 'N', type: 'note', data: { name: 'N' }, position: { x: 0, y: 0 } } as CanvasFlowNode,
    ];
    const deletedEdges: Edge[] = [
      { id: 'S--N', source: 'S', target: 'N', selected: false },
    ];

    await handleCanvasDelete({
      deletedNodes,
      deletedEdges,
      api,
      onRemoveRequest,
    });

    expect(command).not.toHaveBeenCalledWith('note.remove', expect.anything());
    expect(command).not.toHaveBeenCalledWith('edge.disconnect', expect.anything());
    expect(appStore.getState().edges).toEqual([{ a: 'S', b: 'N' }]);
  });

  it('aresta selecionada sozinha é desconectada', async () => {
    const { api, command } = fakeApi();
    const onRemoveRequest = vi.fn();
    const deletedNodes: CanvasFlowNode[] = [];
    const deletedEdges: Edge[] = [
      { id: 'S--T', source: 'S', target: 'T', selected: true },
    ];

    await handleCanvasDelete({
      deletedNodes,
      deletedEdges,
      api,
      onRemoveRequest,
      selectedEdges: new Set(['S--T']),
    });

    expect(onRemoveRequest).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith('edge.disconnect', { a: 'S', b: 'T' });
    expect(appStore.getState().edges).toEqual([]);
  });
});
