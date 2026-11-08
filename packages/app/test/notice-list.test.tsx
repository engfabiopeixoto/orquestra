// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_DISMISS_MS, NoticeList } from '../src/renderer/src/components/NoticeList';
import { appStore } from '../src/renderer/src/store';

beforeEach(() => {
  vi.useFakeTimers();
  appStore.setState({ notices: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('NoticeList', () => {
  it('avisos de qualquer nível somem sozinhos depois de 10 s', () => {
    render(<NoticeList />);
    act(() => {
      appStore.getState().notify('error', 'falhou');
      appStore.getState().notify('info', 'pronto');
    });
    expect(screen.getByText('falhou')).toBeTruthy();
    expect(AUTO_DISMISS_MS).toBe(10000);
    act(() => { vi.advanceTimersByTime(AUTO_DISMISS_MS); });
    expect(screen.queryByText('falhou')).toBeNull();
    expect(screen.queryByText('pronto')).toBeNull();
  });

  it('um aviso novo não reinicia o tempo dos anteriores', () => {
    render(<NoticeList />);
    act(() => { appStore.getState().notify('error', 'primeiro'); });
    act(() => { vi.advanceTimersByTime(6000); });
    act(() => { appStore.getState().notify('error', 'segundo'); });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('primeiro')).toBeNull();
    expect(screen.getByText('segundo')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('segundo')).toBeNull();
  });
});
