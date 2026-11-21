// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QualityReport } from '@orquestra/shared/quality-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { QualityDrawer } from '../src/renderer/src/components/QualityDrawer';
import {
  clampQualityWidth,
  QUALITY_DEFAULT_WIDTH,
  QUALITY_MAX_WIDTH_RATIO,
  QUALITY_MIN_WIDTH,
  readQualityDrawerPrefs,
  writeQualityDrawerPrefs,
} from '../src/renderer/src/layout-prefs';
import { QUALITY_SHORTCUT_HINT } from '../src/renderer/src/canvas/shortcuts';
import { resetPortalOverlaysForTest } from '../src/renderer/src/portal/modal-overlay';

function makeReport(signal: 'ok' | 'warn' | 'bad' | 'missing'): QualityReport {
  return {
    version: 1,
    dir: 'E:/proj/demo',
    measuredAt: '2026-11-20T12:00:00.000Z',
    durationMs: 40,
    language: 'js-ts',
    limits: { files: 1, skippedLarge: 0, truncated: false },
    metrics: [
      { id: 'size', signal, value: signal === 'missing' ? null : 200, delta: null },
      { id: 'complexity', signal: signal === 'missing' ? 'missing' : 'ok', value: signal === 'missing' ? null : 4, delta: null },
      { id: 'dependencies', signal: signal === 'missing' ? 'missing' : 'ok', value: signal === 'missing' ? null : 0, delta: null },
      { id: 'coverage', signal: 'missing', value: null, delta: null },
      { id: 'mutation', signal: 'missing', value: null, delta: null },
    ],
    files: [],
    functions: [],
    cycles: [],
    hotspots: [],
    changed: [],
    coverage: null,
    mutation: null,
  };
}

function makeFakeApi(report: QualityReport | null = makeReport('bad')) {
  const api = {
    command: vi.fn(async (method: string) => {
      if (method === 'quality.read') return { report };
      if (method === 'quality.measure') return report ?? makeReport('ok');
      return {};
    }) as unknown as CommandApi['command'],
  };
  return api;
}

beforeEach(() => {
  localStorage.clear();
  resetPortalOverlaysForTest();
  Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true, configurable: true });
  Object.assign(window, {
    orquestra: {
      ...(window.orquestra ?? {}),
      portal: { setModalState: vi.fn(async () => {}) },
    },
  });
});

afterEach(() => {
  cleanup();
  resetPortalOverlaysForTest();
  vi.restoreAllMocks();
});

describe('QualityDrawer & layout prefs', () => {
  it('mostra faixa vertical recolhida com texto "Qualidade" e ponto da cor do pior sinal', async () => {
    const apiBad = makeFakeApi(makeReport('bad'));
    const { rerender } = render(
      <QualityDrawer
        api={apiBad}
        projectDir="E:/proj/demo"
        workspaceKey="ws-1"
        terminals={[]}
        onOpenFile={() => {}}
      />,
    );

    const toggle = await screen.findByTestId('quality-drawer-toggle');
    expect(toggle.textContent).toContain('Qualidade');
    await waitFor(() => {
      expect(toggle.getAttribute('aria-label')).toContain('Problema');
    });
    expect(toggle.querySelector('.quality-signal-dot')?.className).toContain('is-bad');

    const apiWarn = makeFakeApi(makeReport('warn'));
    rerender(
      <QualityDrawer api={apiWarn} projectDir="E:/proj/warn" workspaceKey="ws-2" terminals={[]} onOpenFile={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('quality-drawer-toggle').getAttribute('aria-label')).toContain('Atenção');
    });
    expect(screen.getByTestId('quality-drawer-toggle').querySelector('.quality-signal-dot')?.className).toContain('is-warn');

    const apiOk = makeFakeApi(makeReport('ok'));
    rerender(
      <QualityDrawer api={apiOk} projectDir="E:/proj/ok" workspaceKey="ws-3" terminals={[]} onOpenFile={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('quality-drawer-toggle').getAttribute('aria-label')).toContain('OK');
    });
    expect(screen.getByTestId('quality-drawer-toggle').querySelector('.quality-signal-dot')?.className).toContain('is-ok');

    const apiNone = makeFakeApi(null);
    rerender(
      <QualityDrawer api={apiNone} projectDir="E:/proj/none" workspaceKey="ws-4" terminals={[]} onOpenFile={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('quality-drawer-toggle').getAttribute('aria-label')).toContain('Sem medição');
    });
    expect(screen.getByTestId('quality-drawer-toggle').querySelector('.quality-signal-dot')?.className).toContain('is-missing');
  });

  it('abre ao clicar na faixa, fecha no botão recolher e persiste aberto/fechado e largura por workspace', async () => {
    const api = makeFakeApi(makeReport('bad'));
    const { unmount } = render(
      <QualityDrawer api={api} projectDir="E:/proj/demo" workspaceKey="ws-persist" terminals={[]} onOpenFile={() => {}} />,
    );

    fireEvent.click(await screen.findByTestId('quality-drawer-toggle'));
    expect(await screen.findByTestId('quality-drawer-collapse')).toBeTruthy();

    const sep = screen.getByRole('separator', { name: /largura/i });
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');

    // ArrowLeft em painel à direita aumenta a largura
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    const afterArrow = Number(sep.getAttribute('aria-valuenow'));
    expect(afterArrow).toBeGreaterThan(before);

    // Respeita limites [260, 50% da janela] e atalhos Home/End
    expect(clampQualityWidth(100, 1200)).toBe(QUALITY_MIN_WIDTH);
    expect(clampQualityWidth(900, 1200)).toBe(Math.floor(1200 * QUALITY_MAX_WIDTH_RATIO));
    fireEvent.keyDown(sep, { key: 'End' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(600);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(QUALITY_MIN_WIDTH);

    // Arrasto por pointer events usa setModalState durante o arrasto e só persiste ao concluir (pointerup)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const drawer = screen.getByTestId('quality-drawer');
    fireEvent.pointerDown(sep, { button: 0, clientX: 800, pointerId: 1 });
    expect(window.orquestra.portal.setModalState).toHaveBeenCalledWith(true);
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    expect(setItemSpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(sep, { clientX: 700, pointerId: 1 });
    expect(window.orquestra.portal.setModalState).toHaveBeenLastCalledWith(false);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();

    const afterDrag = Number(sep.getAttribute('aria-valuenow'));
    expect(afterDrag).toBeGreaterThan(QUALITY_MIN_WIDTH);
    expect(drawer.style.width).toBe(`${afterDrag}px`);

    unmount();
    render(
      <QualityDrawer api={api} projectDir="E:/proj/demo" workspaceKey="ws-persist" terminals={[]} onOpenFile={() => {}} />,
    );
    expect(await screen.findByTestId('quality-drawer-collapse')).toBeTruthy();
    expect(Number(screen.getByRole('separator', { name: /largura/i }).getAttribute('aria-valuenow'))).toBe(afterDrag);

    // Encolher janela limita largura exibida sem sobrescrever preferência salva; ao restaurar janela, duplo clique volta a 320px
    Object.defineProperty(window, 'innerWidth', { value: 600, writable: true, configurable: true });
    fireEvent(window, new Event('resize'));
    expect(Number(screen.getByRole('separator', { name: /largura/i }).getAttribute('aria-valuenow'))).toBe(300);
    expect(readQualityDrawerPrefs('ws-persist').width).toBe(afterDrag);

    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true, configurable: true });
    fireEvent(window, new Event('resize'));
    fireEvent.doubleClick(screen.getByRole('separator', { name: /largura/i }));
    expect(Number(screen.getByRole('separator', { name: /largura/i }).getAttribute('aria-valuenow'))).toBe(QUALITY_DEFAULT_WIDTH);

    // Recolhe e persiste fechado
    fireEvent.click(screen.getByTestId('quality-drawer-collapse'));
    expect(await screen.findByTestId('quality-drawer-toggle')).toBeTruthy();
    expect(readQualityDrawerPrefs('ws-persist').open).toBe(false);
  });

  it('alterna com toggleSignal, modo controlado e troca de workspace sem frame defasado nem quality.read duplicado', async () => {
    writeQualityDrawerPrefs('ws-a', { open: true, width: 420 });
    writeQualityDrawerPrefs('ws-b', { open: false, width: 280 });
    const apiA = makeFakeApi(makeReport('bad'));
    const apiB = makeFakeApi(makeReport('ok'));

    const { rerender } = render(
      <QualityDrawer key="ws-a" api={apiA} projectDir="E:/proj/a" workspaceKey="ws-a" terminals={[]} toggleSignal={0} onOpenFile={() => {}} />,
    );
    expect(screen.getByTestId('quality-drawer').style.width).toBe('420px');
    expect(screen.getByTestId('quality-drawer-collapse')).toBeTruthy();

    rerender(
      <QualityDrawer key="ws-b" api={apiB} projectDir="E:/proj/b" workspaceKey="ws-b" terminals={[]} toggleSignal={0} onOpenFile={() => {}} />,
    );
    expect(screen.getByTestId('quality-drawer-toggle').getAttribute('aria-label')).toContain(QUALITY_SHORTCUT_HINT);
    await waitFor(() => expect(apiB.command).toHaveBeenCalledTimes(1));

    // toggleSignal incrementa -> abre ws-b; modo controlado responde a open/onToggle
    rerender(
      <QualityDrawer key="ws-b" api={apiB} projectDir="E:/proj/b" workspaceKey="ws-b" terminals={[]} toggleSignal={1} onOpenFile={() => {}} />,
    );
    expect(await screen.findByTestId('quality-drawer-collapse')).toBeTruthy();

    const onToggle = vi.fn();
    rerender(
      <QualityDrawer key="ws-ctrl" api={apiA} projectDir="E:/proj/a" workspaceKey="ws-ctrl" terminals={[]} open={false} onToggle={onToggle} onOpenFile={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('quality-drawer-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('tolera JSON corrompido, valores inválidos e falha de leitura/escrita no localStorage', () => {
    localStorage.setItem('orq:quality-drawer:ws-bad', '{broken');
    expect(readQualityDrawerPrefs('ws-bad')).toEqual({ open: false, width: 320 });
    localStorage.setItem('orq:quality-drawer:ws-null', 'null');
    expect(readQualityDrawerPrefs('ws-null')).toEqual({ open: false, width: 320 });
    localStorage.setItem('orq:quality-drawer:ws-neg', JSON.stringify({ open: 'yes', width: -10 }));
    expect(readQualityDrawerPrefs('ws-neg')).toEqual({ open: false, width: 260 });

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage full');
    });

    expect(() => writeQualityDrawerPrefs('ws-err', { open: true, width: 350 })).not.toThrow();
    expect(readQualityDrawerPrefs('ws-err')).toEqual({ open: false, width: 320 });
  });
});
