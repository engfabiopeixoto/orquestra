// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setModalState } = vi.hoisted(() => {
  const setModalState = vi.fn(async () => ({ ok: true }));
  Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), portal: { setModalState } } });
  return { setModalState };
});

import type { CommandApi } from '../src/renderer/src/api';
import { ContextBar } from '../src/renderer/src/components/ContextBar';
import { resetPortalOverlaysForTest, usePortalOverlay } from '../src/renderer/src/portal/modal-overlay';
import { appStore } from '../src/renderer/src/store';
import { ModelTag } from '../src/renderer/src/terminal/ModelTag';

function OverlayProbe({ active }: { active: boolean }) {
  usePortalOverlay(active);
  return null;
}

describe('usePortalOverlay', () => {
  beforeEach(() => {
    setModalState.mockClear();
    resetPortalOverlaysForTest();
  });
  afterEach(cleanup);

  it('agrega múltiplos overlays sem MutationObserver e só libera quando o último fecha', () => {
    const first = render(<OverlayProbe active={false} />);
    const second = render(<OverlayProbe active={false} />);
    expect(setModalState).not.toHaveBeenCalledWith(true);

    first.rerender(<OverlayProbe active={true} />);
    expect(setModalState).toHaveBeenLastCalledWith(true);

    const callsAfterFirst = setModalState.mock.calls.length;
    second.rerender(<OverlayProbe active={true} />);
    expect(setModalState.mock.calls.length).toBe(callsAfterFirst);

    first.rerender(<OverlayProbe active={false} />);
    expect(setModalState.mock.calls.length).toBe(callsAfterFirst);

    second.unmount();
    expect(setModalState).toHaveBeenLastCalledWith(false);
  });

  it('ModelTag e QueuePanel do ContextBar registram overlay para não ficarem atrás do portal nativo', () => {
    appStore.setState({
      terminals: {
        A: { id: 't1', name: 'A', agent: 'claude', state: 'idle', queued: 0, cwd: 'C:/p', args: [], resume: true, regente: false, monitor: false, position: { x: 0, y: 0 }, size: { width: 640, height: 400 }, notice: null, epoch: 0 },
      },
      queues: { A: [{ askId: 'q1', from: 'B', preview: 'oi', status: 'queued', kind: 'prompt' }] },
    });
    const api = { command: vi.fn(async () => ({})) } as unknown as CommandApi;

    const tag = render(<ModelTag name="A" agent="claude" model={undefined} api={api} />);
    fireEvent.click(screen.getByTestId('terminal-model-A'));
    expect(setModalState).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('terminal-model-A'));
    expect(setModalState).toHaveBeenLastCalledWith(false);
    tag.unmount();

    render(<ContextBar name="A" />);
    fireEvent.click(screen.getByTestId('ctx-queue'));
    expect(setModalState).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('ctx-queue'));
    expect(setModalState).toHaveBeenLastCalledWith(false);
  });
});
