// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostEvent } from '@orquestra/shared/host-protocol';
import type { CommandApi } from '../src/renderer/src/api';
import { SubscriptionUsage } from '../src/renderer/src/components/SubscriptionUsage';
import { routeEvent } from '../src/renderer/src/events';
import { OutputBus } from '../src/renderer/src/output-bus';
import { appStore } from '../src/renderer/src/store';

afterEach(() => {
  cleanup();
  appStore.setState({ usage: {} } as never);
});
it('consulta sem inferência, mostra limites e abre a assinatura selecionada', async () => {
  const openSubscription = vi.fn();
  Object.assign(window, { orquestra: { openSubscription } });
  const command = vi.fn().mockImplementation(async (method: string) => ({ checkedAt: new Date().toISOString(), windows: [{ label: '5 h', usedPercent: method === 'usage.codex' ? 32 : 98, resetsAt: null }, { label: '7 dias', usedPercent: 72, resetsAt: null }], credits: '10', details: [] }));
  render(<SubscriptionUsage api={{ command } as unknown as CommandApi} />);
  await waitFor(() => expect(screen.getByTestId('usage-summary-codex-5h').textContent).toBe('32%'));
  expect(screen.getByTestId('usage-summary-codex-7d').textContent).toBe('72%');
  fireEvent.click(screen.getByRole('button', { name: /Uso das assinaturas/ }));
  await screen.findByText('32% usado');
  expect(command).toHaveBeenCalledWith('usage.codex', {});
  expect(command).toHaveBeenCalledWith('usage.claude', {});
  const codex = within(screen.getByRole('region', { name: 'Assinatura Codex · ChatGPT' }));
  expect((codex.getAllByRole('progressbar')[0] as HTMLProgressElement).value).toBe(32);
  fireEvent.click(within(screen.getByRole('region', { name: 'Assinatura Claude' })).getByRole('button', { name: 'Abrir conta ↗' }));
  expect(openSubscription).toHaveBeenCalledWith('claude');
});
it('exibe falha de consulta sem inventar saldo', async () => {
  const command = vi.fn().mockImplementation(async (method: string) => { if (method === 'usage.codex') throw new Error('Entre no Codex.'); return { checkedAt: new Date().toISOString(), windows: [{ label: '7 dias', usedPercent: 50, resetsAt: null }], credits: null, details: [] }; });
  render(<SubscriptionUsage api={{ command } as unknown as CommandApi} />);
  fireEvent.click(screen.getByRole('button', { name: /Uso das assinaturas/ }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Entre no Codex.'));
  expect(within(screen.getByRole('region', { name: 'Assinatura Codex · ChatGPT' })).queryByRole('progressbar')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Assinatura Claude' })).getByRole('progressbar')).toBeDefined();
});
it('só consulta o Antigravity quando pedem, porque cada consulta abre o agy e o atualizador dele pisca uma janela', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const command = vi.fn().mockImplementation(async () => ({ checkedAt: new Date().toISOString(), windows: [{ label: 'Gemini · 7 dias', usedPercent: 40, resetsAt: null }], credits: null, details: [] }));
    render(<SubscriptionUsage api={{ command } as unknown as CommandApi} />);
    await waitFor(() => expect(command).toHaveBeenCalledWith('usage.codex', {}));
    await vi.advanceTimersByTimeAsync(600000);
    expect(command).not.toHaveBeenCalledWith('usage.agy', {});
    fireEvent.click(screen.getByRole('button', { name: /Uso das assinaturas/ }));
    const agy = within(screen.getByRole('region', { name: 'Assinatura Antigravity' }));
    expect(agy.getByText(/Clique em Atualizar/)).toBeDefined();
    fireEvent.click(agy.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(screen.getByTestId('usage-summary-agy-7d').textContent).toBe('G 40%'));
    expect(command.mock.calls.filter(([method]) => method === 'usage.agy')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('atualiza resumo e detalhes ao receber usage.updated remoto (ex.: consulta do celular ou orq usage)', async () => {
  const command = vi.fn().mockImplementation(async () => ({ checkedAt: new Date().toISOString(), windows: [{ label: '7 dias', usedPercent: 10, resetsAt: null }], credits: null, details: [] }));
  render(<SubscriptionUsage api={{ command } as unknown as CommandApi} />);
  await waitFor(() => expect(command).toHaveBeenCalledWith('usage.codex', {}));

  act(() => {
    routeEvent(
      {
        type: 'usage.updated',
        provider: 'agy',
        usage: {
          checkedAt: '2026-11-18T03:00:00Z',
          windows: [{ label: 'Gemini · 7 dias', usedPercent: 64, resetsAt: null }],
          credits: '150',
          details: [],
        },
      } as HostEvent,
      { store: appStore.getState(), bus: new OutputBus() },
    );
  });

  await waitFor(() => expect(screen.getByTestId('usage-summary-agy-7d').textContent).toBe('G 64%'));
  fireEvent.click(screen.getByRole('button', { name: /Uso das assinaturas/ }));
  const agy = within(screen.getByRole('region', { name: 'Assinatura Antigravity' }));
  expect(agy.getByText('64% usado')).toBeDefined();
  expect(agy.getByText('Créditos: 150')).toBeDefined();
});
