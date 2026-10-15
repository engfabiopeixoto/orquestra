// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Position, type EdgeProps } from '@xyflow/react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisconnectEdgeContext, RemovableEdge } from '../src/renderer/src/canvas/RemovableEdge';

// O EdgeLabelRenderer usa um portal para o DOM do ReactFlow, ausente neste teste isolado.
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => createPortal(children, document.body),
}));

afterEach(cleanup);

const props = (overrides: Partial<EdgeProps> = {}) => ({
  id: 'A--B', source: 'A', target: 'B', sourceX: 0, sourceY: 0, targetX: 200, targetY: 100,
  sourcePosition: Position.Right, targetPosition: Position.Left, selected: false, data: undefined,
  ...overrides,
}) as unknown as EdgeProps;

const renderEdge = (edgeProps: EdgeProps, disconnect = vi.fn()) => render(
  <DisconnectEdgeContext.Provider value={disconnect}>
    <svg><RemovableEdge {...edgeProps} /></svg>
  </DisconnectEdgeContext.Provider>,
);

describe('RemovableEdge', () => {
  it('desenha a linha e expõe o botão de desconectar com rótulo acessível', () => {
    const { container } = renderEdge(props());
    expect(container.querySelector('path.react-flow__edge-path')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Desconectar' });
    expect(button.className).toContain('nodrag');
    expect(button.className).toContain('nopan');
  });

  it('chama a desconexão com a origem, o destino e os dados da aresta ao clicar no ×', () => {
    const disconnect = vi.fn();
    renderEdge(props({ data: { kind: 'flow', id: 'c1' } }), disconnect);
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    expect(disconnect).toHaveBeenCalledWith({ source: 'A', target: 'B', data: { kind: 'flow', id: 'c1' } });
  });

  it('mostra o botão em hover e quando a aresta está selecionada', () => {
    const { container, rerender } = renderEdge(props());
    const button = () => screen.getByRole('button', { name: 'Desconectar' });
    expect(button().className).not.toContain('visible');
    fireEvent.mouseEnter(container.querySelector('g.orq-edge-hit')!);
    expect(button().className).toContain('visible');
    fireEvent.mouseLeave(container.querySelector('g.orq-edge-hit')!);
    expect(button().className).not.toContain('visible');
    rerender(
      <DisconnectEdgeContext.Provider value={vi.fn()}>
        <svg><RemovableEdge {...props({ selected: true })} /></svg>
      </DisconnectEdgeContext.Provider>,
    );
    expect(button().className).toContain('visible');
  });

  it('mostra a pílula do tipo de pedido e a esconde em hover para dar lugar ao ×', () => {
    const { container } = renderEdge(props({ data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    expect(screen.getByTestId('edge-pill-A--B').textContent).toBe('⚡ delegando');
    fireEvent.mouseEnter(container.querySelector('g.orq-edge-hit')!);
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });

  it('mantém os controles visíveis ao mover o mouse da linha para o botão', () => {
    const { container } = renderEdge(props({ data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    const line = container.querySelector('g.orq-edge-hit')!;
    const button = screen.getByRole('button', { name: 'Desconectar' });
    fireEvent.mouseEnter(line);
    fireEvent.mouseLeave(line);
    fireEvent.mouseEnter(button);
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
    expect(button.className).toContain('visible');
  });

  it('mantém a pílula escondida quando o botão recebe foco', () => {
    renderEdge(props({ data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    const button = screen.getByRole('button', { name: 'Desconectar' });
    fireEvent.focus(button);
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
    expect(button.className).toContain('visible');
  });

  it('usa rótulo neutro para delivery; sem atividade não há pílula', () => {
    renderEdge(props({ data: { activity: { flow: 'b→a', kind: 'delivery', running: false } } }));
    expect(screen.getByTestId('edge-pill-A--B').textContent).toBe('📩 entregando');
    cleanup();
    renderEdge(props());
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });

  it('usa rótulo retornando para respostas', () => {
    renderEdge(props({ data: { activity: { flow: 'b→a', kind: 'reply', running: false } } }));
    expect(screen.getByTestId('edge-pill-A--B').textContent).toBe('📩 retornando');
  });

  it('aresta selecionada esconde a pílula', () => {
    renderEdge(props({ selected: true, data: { activity: { flow: 'a→b', kind: 'prompt', running: true } } }));
    expect(screen.queryByTestId('edge-pill-A--B')).toBeNull();
  });
});
