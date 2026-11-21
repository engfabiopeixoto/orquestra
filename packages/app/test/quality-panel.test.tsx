// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QualityReport } from '@orquestra/shared/quality-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { QualityPanel } from '../src/renderer/src/components/QualityPanel';
import { resetPortalOverlaysForTest } from '../src/renderer/src/portal/modal-overlay';

function makeReport(overrides: Partial<QualityReport> = {}): QualityReport {
  return {
    version: 1,
    dir: 'E:/proj/demo',
    measuredAt: '2026-11-20T12:00:00.000Z',
    durationMs: 120,
    language: 'js-ts',
    limits: { files: 10, skippedLarge: 0, truncated: false },
    metrics: [
      { id: 'size', signal: 'bad', value: 700, delta: 100 },
      { id: 'complexity', signal: 'warn', value: 14, delta: -2 },
      { id: 'dependencies', signal: 'bad', value: 1, delta: 1 },
      { id: 'coverage', signal: 'missing', value: null, delta: null },
      { id: 'mutation', signal: 'ok', value: 85, delta: 5 },
    ],
    files: [],
    functions: [
      { path: 'src/big.ts', line: 12, name: 'render', complexity: 14, depth: 3, loc: 80 },
    ],
    cycles: [{ files: ['src/a.ts', 'src/b.ts'], typeOnly: false }],
    hotspots: [
      { path: 'src/big.ts', score: 980, reason: '700 linhas, função render com complexidade 14' },
    ],
    changed: [
      { path: 'src/big.ts', kind: 'file-over-limit', detail: 'Passou de 350 linhas (700 linhas).' },
    ],
    coverage: null,
    mutation: {
      generatedAt: '2026-11-20T11:00:00.000Z',
      score: 85,
      files: [],
      survivors: [],
    },
    ...overrides,
  };
}

function makeFakeApi(opts: {
  readReport?: QualityReport | null;
  measureReport?: QualityReport;
  measurePromise?: Promise<QualityReport>;
  failMeasure?: string;
} = {}) {
  const calls: Array<[string, unknown]> = [];
  const api = {
    command: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'quality.read') return { report: opts.readReport ?? null };
      if (method === 'quality.measure') {
        if (opts.failMeasure) throw new Error(opts.failMeasure);
        if (opts.measurePromise) return opts.measurePromise;
        return opts.measureReport ?? makeReport();
      }
      if (method === 'quality.ask') return {};
      return {};
    }) as unknown as CommandApi['command'],
  };
  return { api, calls };
}

let setModalState = vi.fn(async () => {});

beforeEach(() => {
  resetPortalOverlaysForTest();
  setModalState = vi.fn(async () => {});
  Object.assign(window, {
    orquestra: {
      ...(window.orquestra ?? {}),
      portal: { setModalState },
    },
  });
});

afterEach(() => {
  cleanup();
  resetPortalOverlaysForTest();
});

describe('QualityPanel', () => {
  it('renderiza os 5 cartões, sinais em texto e guia expansível no botão ?', async () => {
    const { api } = makeFakeApi({ readReport: makeReport() });
    render(<QualityPanel api={api} projectDir="E:/proj/demo" terminals={[]} onOpenFile={() => {}} />);

    await screen.findByText('Tamanho dos módulos');
    expect(screen.getByText('Complexidade')).toBeTruthy();
    expect(screen.getByText('Dependências')).toBeTruthy();
    expect(screen.getByText('Cobertura de testes')).toBeTruthy();
    expect(screen.getByText('Teste de mutação')).toBeTruthy();

    expect(screen.getAllByText('PROBLEMA').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('ATENÇÃO')).toBeTruthy();
    expect(screen.getByText('SEM DADOS')).toBeTruthy();
    expect(screen.getByText('OK')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Explicar Tamanho dos módulos' }));
    expect(screen.getByText(/O que é:/)).toBeTruthy();
    expect(screen.getByText(/Por que importa:/)).toBeTruthy();
    expect(screen.getByText(/Limites usados aqui:/)).toBeTruthy();
    expect(screen.getByText(/Como melhorar:/)).toBeTruthy();
  });

  it('mostra "Pedir a um agente", filtra shells/descarregados/encerrados, registra portal overlay e envia quality.ask', async () => {
    const { api, calls } = makeFakeApi({ readReport: makeReport() });
    render(
      <QualityPanel
        api={api}
        projectDir="E:/proj/demo"
        terminals={[
          { name: 'sh-1', agent: 'shell', state: 'idle' },
          { name: 'claude-off', agent: 'claude', state: 'exited' },
          { name: 'agy-unloaded', agent: 'agy', state: 'idle', unloaded: true },
          { name: 'codex-1', agent: 'codex', state: 'idle' },
        ]}
        onOpenFile={() => {}}
      />,
    );

    const askButton = await screen.findByRole('button', { name: 'Pedir a um agente' });
    expect(askButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(askButton);
    expect(setModalState).toHaveBeenCalledWith(true);

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.map((el) => el.textContent)).toEqual(['codex-1 (codex)']);

    fireEvent.click(menuItems[0]!);
    await waitFor(() => {
      expect(calls).toContainEqual(['quality.ask', { name: 'codex-1', kind: 'coverage' }]);
    });
    expect(setModalState).toHaveBeenLastCalledWith(false);
  });

  it('desabilita "Pedir a um agente" quando só existem shells, descarregados ou encerrados', async () => {
    const { api } = makeFakeApi({ readReport: makeReport() });
    render(
      <QualityPanel
        api={api}
        projectDir="E:/proj/demo"
        terminals={[
          { name: 'sh', agent: 'shell', state: 'idle' },
          { name: 'old', agent: 'claude', state: 'exited' },
          { name: 'u', agent: 'agy', state: 'idle', unloaded: true },
        ]}
        onOpenFile={() => {}}
      />,
    );

    const askButton = await screen.findByRole('button', { name: 'Pedir a um agente' });
    expect(askButton.hasAttribute('disabled')).toBe(true);
    expect(askButton.getAttribute('title')).toBe('Abra um terminal de agente');
  });

  it('mostra mensagem específica para linguagem unsupported', async () => {
    const { api } = makeFakeApi({
      readReport: makeReport({
        language: 'unsupported',
        hotspots: [],
        cycles: [],
        functions: [],
        changed: [],
      }),
    });
    render(<QualityPanel api={api} projectDir="E:/proj/py" terminals={[]} onOpenFile={() => {}} />);

    await screen.findByText('Por enquanto o painel só analisa projetos JavaScript e TypeScript.');
    expect(screen.queryByText('Tamanho dos módulos')).toBeNull();
  });

  it('clicar em hotspot chama onOpenFile e delta de cobertura +5 mostra "melhorou"', async () => {
    const onOpenFile = vi.fn();
    const report = makeReport({
      metrics: [
        { id: 'size', signal: 'bad', value: 700, delta: 100 },
        { id: 'complexity', signal: 'ok', value: 5, delta: -1 },
        { id: 'dependencies', signal: 'ok', value: 0, delta: 0 },
        { id: 'coverage', signal: 'ok', value: 75, delta: 5 },
        { id: 'mutation', signal: 'missing', value: null, delta: null },
      ],
      coverage: {
        source: 'summary',
        generatedAt: '2026-11-20T12:00:00.000Z',
        stale: false,
        lines: 75,
        branches: null,
        functions: null,
        files: [],
      },
      mutation: null,
    });
    const { api } = makeFakeApi({ readReport: report });
    render(<QualityPanel api={api} projectDir="E:/proj/demo" terminals={[]} onOpenFile={onOpenFile} />);

    const covCard = (await screen.findByText('Cobertura de testes')).closest('.quality-card')!;
    expect(covCard.textContent).toContain('▲ +5% melhorou');
    const sizeCard = screen.getByText('Tamanho dos módulos').closest('.quality-card')!;
    expect(sizeCard.textContent).toContain('▲ +100 piorou');

    const hotspotsSection = screen.getByText('Pontos críticos').closest('.quality-section') as HTMLElement;
    const hotspotBtn = within(hotspotsSection).getByRole('button', { name: /src\/big\.ts/i });
    fireEvent.click(hotspotBtn);
    expect(onOpenFile).toHaveBeenCalledWith('src/big.ts');
  });

  it('mantém resultado anterior visível enquanto mede e exibe erro como usage-error', async () => {
    let resolveMeasure!: (r: QualityReport) => void;
    const measurePromise = new Promise<QualityReport>((resolve) => {
      resolveMeasure = resolve;
    });
    const { api } = makeFakeApi({ readReport: makeReport(), measurePromise });

    render(<QualityPanel api={api} projectDir="E:/proj/demo" terminals={[]} onOpenFile={() => {}} />);
    await screen.findByText('Tamanho dos módulos');

    const measureBtn = screen.getByRole('button', { name: 'Medir' });
    fireEvent.click(measureBtn);

    expect(screen.getByRole('button', { name: 'Medindo…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Tamanho dos módulos')).toBeTruthy();

    resolveMeasure(makeReport());
    await screen.findByRole('button', { name: 'Medir' });

    const failApi = makeFakeApi({ readReport: null, failMeasure: 'Falha ao medir projeto.' });
    cleanup();
    render(<QualityPanel api={failApi.api} projectDir="E:/proj/demo" terminals={[]} onOpenFile={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Medir' }));
    const err = await screen.findByRole('status');
    expect(err.className).toContain('usage-error');
    expect(err.textContent).toContain('Falha ao medir projeto.');
  });

  it('quality.read atrasado não sobrescreve resultado de Medir e troca de projectDir descarta resposta antiga', async () => {
    let resolveRead!: (v: { report: QualityReport | null }) => void;
    const staleRead = new Promise<{ report: QualityReport | null }>((r) => { resolveRead = r; });
    let resolveMeasureB!: (r: QualityReport) => void;
    const slowMeasureA = new Promise<QualityReport>((r) => { resolveMeasureB = r; });

    const measuredReport = makeReport({
      metrics: [
        { id: 'size', signal: 'ok', value: 123, delta: 0 },
        { id: 'complexity', signal: 'ok', value: 2, delta: 0 },
        { id: 'dependencies', signal: 'ok', value: 0, delta: 0 },
        { id: 'coverage', signal: 'missing', value: null, delta: null },
        { id: 'mutation', signal: 'missing', value: null, delta: null },
      ],
    });
    const oldReadReport = makeReport({
      metrics: [
        { id: 'size', signal: 'bad', value: 999, delta: null },
        { id: 'complexity', signal: 'ok', value: 1, delta: null },
        { id: 'dependencies', signal: 'ok', value: 0, delta: null },
        { id: 'coverage', signal: 'missing', value: null, delta: null },
        { id: 'mutation', signal: 'missing', value: null, delta: null },
      ],
    });

    let readCount = 0;
    const api = {
      command: vi.fn(async (method: string) => {
        if (method === 'quality.read') {
          readCount++;
          return readCount === 1 ? staleRead : { report: null };
        }
        if (method === 'quality.measure') return measuredReport;
        return {};
      }) as unknown as CommandApi['command'],
    };

    const { rerender } = render(<QualityPanel api={api} projectDir="E:/proj/A" terminals={[]} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Medir' }));
    await screen.findByText('123 linhas');

    // Agora quality.read antigo resolve depois do Medir — não deve sobrescrever 123 linhas por 999 linhas
    resolveRead({ report: oldReadReport });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText('123 linhas')).toBeTruthy();
    expect(screen.queryByText('999 linhas')).toBeNull();

    // Agora testa troca de projectDir enquanto measure está em voo
    const apiSwitch = {
      command: vi.fn(async (method: string) => {
        if (method === 'quality.read') return { report: null };
        if (method === 'quality.measure') return slowMeasureA;
        return {};
      }) as unknown as CommandApi['command'],
    };
    rerender(<QualityPanel api={apiSwitch} projectDir="E:/proj/A2" terminals={[]} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Medir' }));
    rerender(<QualityPanel api={apiSwitch} projectDir="E:/proj/B" terminals={[]} onOpenFile={() => {}} />);
    resolveMeasureB(measuredReport);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('123 linhas')).toBeNull();
  });

  it('menu de agentes fecha no Escape devolvendo foco, fecha fora e fecha se o último agente sair', async () => {
    const { api } = makeFakeApi({ readReport: makeReport() });
    const { rerender } = render(
      <QualityPanel
        api={api}
        projectDir="E:/proj/demo"
        terminals={[{ name: 'codex-1', agent: 'codex', state: 'idle' }]}
        onOpenFile={() => {}}
      />,
    );

    const askBtn = await screen.findByRole('button', { name: 'Pedir a um agente' });
    fireEvent.click(askBtn);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(askBtn);

    fireEvent.click(askBtn);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    // Abre e depois o último agente sai
    fireEvent.click(askBtn);
    expect(setModalState).toHaveBeenLastCalledWith(true);
    rerender(
      <QualityPanel
        api={api}
        projectDir="E:/proj/demo"
        terminals={[{ name: 'codex-1', agent: 'codex', state: 'exited' }]}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(setModalState).toHaveBeenLastCalledWith(false);
  });

  it('exibe feedback com role="status", aviso de coverage stale e rodapé de limites', async () => {
    const { api } = makeFakeApi({
      readReport: makeReport({
        limits: { files: 5000, skippedLarge: 2, truncated: true },
        metrics: [
          { id: 'size', signal: 'ok', value: 100, delta: null },
          { id: 'complexity', signal: 'ok', value: 3, delta: null },
          { id: 'dependencies', signal: 'ok', value: 0, delta: null },
          { id: 'coverage', signal: 'warn', value: 60, delta: -5 },
          { id: 'mutation', signal: 'missing', value: null, delta: null },
        ],
        coverage: {
          source: 'summary',
          generatedAt: '2026-11-20T10:00:00.000Z',
          stale: true,
          lines: 60,
          branches: null,
          functions: null,
          files: [],
        },
        mutation: null,
      }),
    });

    render(
      <QualityPanel
        api={api}
        projectDir="E:/proj/demo"
        terminals={[{ name: 'claude-1', agent: 'claude', state: 'idle' }]}
        onOpenFile={() => {}}
      />,
    );

    const covCard = (await screen.findByText('Cobertura de testes')).closest('.quality-card')!;
    expect(covCard.textContent).toContain('▼ -5% piorou');
    expect(covCard.textContent).toContain('Relatório antigo');
    expect(screen.getByText(/5\.000 arquivos/)).toBeTruthy();
    expect(screen.getByText(/2 arquivo\(s\) acima de 1 MB pulado\(s\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pedir a um agente' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'claude-1 (claude)' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Pedido enviado para claude-1.');
  });
});
