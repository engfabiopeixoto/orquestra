// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { Profiler, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
  Object.assign(window, {
    orquestra: {
      invoke: async () => ({ ok: true, result: {} }),
      reportError: () => {},
      onEvent: () => () => {},
    },
  });
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    parser = {
      registerCsiHandler() { return { dispose() {} }; },
      registerDcsHandler() { return { dispose() {} }; },
      registerOscHandler() { return { dispose() {} }; },
    };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    write() {}
    clear() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

import { ZoomControl } from '../src/renderer/src/canvas/ZoomControl';
import { GroupFrame } from '../src/renderer/src/groups/GroupFrame';
import { GroupUIContext } from '../src/renderer/src/groups/ui-actions';
import { appStore } from '../src/renderer/src/store';
import { TerminalNode } from '../src/renderer/src/terminal/TerminalNode';

afterEach(cleanup);

describe('useStore no viewport: pan puro não re-renderiza nós nem controles de zoom', () => {
  beforeEach(() => {
    appStore.setState({
      project: { dir: 'C:/proj', name: 'proj', workspaceId: 'w1' },
      terminals: {
        A: {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'A',
          agent: 'shell',
          state: 'idle',
          queued: 0,
          cwd: 'C:/proj',
          args: [],
          resume: false,
          regente: false,
          monitor: false,
          position: { x: 0, y: 0 },
          size: { width: 640, height: 400 },
          notice: null,
          epoch: 0,
        },
      },
      groups: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Equipe',
          color: '#7aa7ff',
          kind: 'agents',
          position: { x: -24, y: -72 },
          size: { width: 700, height: 500 },
          members: [{ kind: 'terminal', id: '11111111-1111-4111-8111-111111111111' }],
          locked: false,
          order: 0,
        },
      ],
    });
  });

  it('mantém 0 re-renders em TerminalNode, GroupFrame e ZoomControl durante pan e preserva modo leitura fora de zoom 100%', () => {
    let storeApi!: ReturnType<typeof useStoreApi>;
    function StoreBridge() {
      storeApi = useStoreApi();
      return null;
    }

    const renders = { terminal: 0, group: 0, zoom: 0 };
    render(
      <GroupUIContext.Provider value={{ edit: () => {}, members: () => {}, newTerminal: () => {}, newNote: () => {} }}>
      <ReactFlowProvider>
        <StoreBridge />
        <Profiler id="terminal" onRender={() => { renders.terminal++; }}>
          <TerminalNode
            {...({
              id: 'A',
              type: 'terminal',
              data: { name: 'A' },
              selected: false,
              dragging: false,
              zIndex: 0,
              isConnectable: true,
              positionAbsoluteX: 0,
              positionAbsoluteY: 0,
            } as ComponentProps<typeof TerminalNode>)}
          />
        </Profiler>
        <Profiler id="group" onRender={() => { renders.group++; }}>
          <GroupFrame
            {...({
              id: '__orq_group_22222222-2222-4222-8222-222222222222',
              type: 'groupFrame',
              data: { groupId: '22222222-2222-4222-8222-222222222222' },
              selected: false,
              dragging: false,
              zIndex: -1,
              isConnectable: false,
              positionAbsoluteX: -24,
              positionAbsoluteY: -72,
            } as ComponentProps<typeof GroupFrame>)}
          />
        </Profiler>
        <Profiler id="zoom" onRender={() => { renders.zoom++; }}>
          <ZoomControl />
        </Profiler>
      </ReactFlowProvider>
      </GroupUIContext.Provider>,
    );

    expect(screen.getByTestId('zoom-level').textContent).toBe('100%');
    expect(screen.queryByText('duplo clique para interagir')).toBeNull();
    const afterMount = { ...renders };

    // Pan puro altera apenas transform[0] e transform[1], mantendo zoom = 1
    for (let i = 1; i <= 10; i++) {
      act(() => {
        storeApi.setState({ transform: [i * 25, i * -15, 1] });
      });
    }
    expect(renders).toEqual(afterMount);

    // Mudar o zoom para 50% ativa modo leitura no TerminalNode e atualiza ZoomControl
    act(() => {
      storeApi.setState({ transform: [100, -50, 0.5] });
    });
    expect(screen.getByTestId('zoom-level').textContent).toBe('50%');
    expect(screen.getByText('duplo clique para interagir')).toBeDefined();

    // Pan em zoom 50% também não re-renderiza nenhum dos três
    const afterZoom = { ...renders };
    act(() => {
      storeApi.setState({ transform: [300, -200, 0.5] });
    });
    expect(renders).toEqual(afterZoom);

    // Voltar para 100% desativa modo leitura
    act(() => {
      storeApi.setState({ transform: [300, -200, 1] });
    });
    expect(screen.getByTestId('zoom-level').textContent).toBe('100%');
    expect(screen.queryByText('duplo clique para interagir')).toBeNull();
  });
});
