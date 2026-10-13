import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { disconnectEdge } from '../src/renderer/src/canvas/disconnect-edge';
import { appStore } from '../src/renderer/src/store';

function fakeApi(impl: (method: string, params: unknown) => unknown): { api: CommandApi; command: ReturnType<typeof vi.fn> } {
  const command = vi.fn(async (method: string, params: unknown) => impl(method, params));
  return { api: { command } as unknown as CommandApi, command };
}

describe('disconnectEdge', () => {
  beforeEach(() => {
    appStore.setState({ edges: [{ a: 'A', b: 'B' }, { a: 'B', b: 'C' }], notices: [] } as never);
  });

  it('desconecta uma conversa no host e remove a aresta da store', async () => {
    const { api, command } = fakeApi(() => ({}));
    await disconnectEdge({ source: 'A', target: 'B' }, api);
    expect(command).toHaveBeenCalledWith('edge.disconnect', { a: 'A', b: 'B' });
    expect(appStore.getState().edges).toEqual([{ a: 'B', b: 'C' }]);
  });

  it('desconecta uma aresta de dados pelo id do fluxo e aplica o grafo devolvido', async () => {
    const graph = { nodes: [], connections: [] };
    const applyFlow = vi.fn();
    appStore.setState({ applyFlow } as never);
    const { api, command } = fakeApi(() => graph);
    await disconnectEdge({ source: 'A', target: 'B', data: { kind: 'flow', id: 'c1' } }, api);
    expect(command).toHaveBeenCalledWith('flow.disconnect', { id: 'c1' });
    expect(applyFlow).toHaveBeenCalledWith(graph);
    expect(appStore.getState().edges).toHaveLength(2);
  });

  it('avisa com notificação de erro quando o host recusa e preserva a aresta', async () => {
    const notify = vi.fn();
    appStore.setState({ notify } as never);
    const { api } = fakeApi(() => { throw new Error('falhou'); });
    await disconnectEdge({ source: 'A', target: 'B' }, api);
    expect(notify).toHaveBeenCalledWith('error', 'falhou');
    expect(appStore.getState().edges).toHaveLength(2);
  });
});
