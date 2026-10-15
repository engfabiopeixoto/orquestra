import { expect, test } from '@playwright/test';
import type { HostEvent } from '@orquestra/shared/host-protocol';
import { createShell, launchApp } from './launch';

test('a conexão acende no sentido do pedido e a moldura mostra o estado do terminal', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await createShell(page, 'T');
    await page.getByTestId('palette-connect').click();
    await page.getByTestId('terminal-header-S').click();
    await page.getByTestId('terminal-header-T').click();
    const edge = page.locator('.react-flow__edge.orq-edge');
    await expect(edge).toHaveCount(1);
    await expect(edge).not.toHaveClass(/orq-edge--active/);
    await expect(page.locator('.react-flow')).toHaveAttribute('data-motion', 'contained');

    const workspaceId = await page.evaluate(async () => {
      const result = await window.orquestra.invoke('workspace.list', {});
      if (!result.ok) throw new Error('Não foi possível consultar o workspace de teste.');
      return (result.result as { selectedId: string }).selectedId;
    });
    type CanvasEvent = Extract<HostEvent, { type: 'terminal.queue' | 'terminal.state' }>;
    const send = (event: CanvasEvent) => app.evaluate(({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('orq:event', message);
    }, event);

    await send({ type: 'terminal.queue', name: 'T', entries: [{ askId: 'x', from: 'S', preview: 'p', status: 'running', kind: 'prompt' }], workspaceId });
    await expect(edge).toHaveClass(/orq-edge--active/);
    await expect(edge).toHaveClass(/orq-edge--running/);
    await expect(page.getByTestId('edge-pill-S--T')).toHaveText('⚡ delegando');

    await send({ type: 'terminal.queue', name: 'T', entries: [], workspaceId });
    await expect(edge).not.toHaveClass(/orq-edge--running/);
    await expect(page.getByTestId('edge-pill-S--T')).toBeVisible();
    await expect(page.getByTestId('edge-pill-S--T')).toHaveCount(0, { timeout: 6000 });
    await expect(edge).not.toHaveClass(/orq-edge--active/);

    const card = page.locator('[data-id="S"] .term-node');
    await send({ type: 'terminal.state', name: 'S', state: 'waiting', queued: 0, sequence: 1_000_000, workspaceId });
    await expect(card).toHaveClass(/frame-waiting/);
    await expect(page.getByTestId('terminal-waiting-S')).toHaveText('👋 aguardando você');
    await send({ type: 'terminal.state', name: 'S', state: 'busy', queued: 0, sequence: 1_000_001, workspaceId });
    await expect(card).toHaveClass(/frame-busy/);
    await expect(page.getByTestId('terminal-waiting-S')).toHaveCount(0);
  } finally { await app.close(); }
});
