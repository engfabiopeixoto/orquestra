import { expect, test } from '@playwright/test';
import type { HostEvent } from '@orquestra/shared/host-protocol';
import { createShell, launchApp } from './launch';

test('eventos atrasados não revertem o estado e a contagem da fila no canvas', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    const workspaceId = await page.evaluate(async () => {
      const result = await window.orquestra.invoke('workspace.list', {});
      if (!result.ok) throw new Error('Não foi possível consultar o workspace de teste.');
      return (result.result as { selectedId: string }).selectedId;
    });
    const send = (events: Array<Extract<HostEvent, { type: 'terminal.state' }>>) => app.evaluate(({ BrowserWindow }, messages) => {
      for (const event of messages) BrowserWindow.getAllWindows()[0]!.webContents.send('orq:event', event);
    }, events);
    const base = { type: 'terminal.state' as const, name: 'S', workspaceId };
    await send([{ ...base, state: 'busy', queued: 2, sequence: 1_000_000 }]);
    await expect(page.getByTestId('terminal-state-S')).toContainText('ocupado');
    await expect(page.getByTestId('terminal-state-S')).toContainText('2 na fila');
    await send([
      { ...base, state: 'idle', queued: 0, sequence: 999_999 },
      { ...base, state: 'waiting', queued: 2, sequence: 1_000_001 },
      { ...base, state: 'busy', queued: 2, sequence: 1_000_000 },
    ]);
    await expect(page.getByTestId('terminal-state-S')).toContainText('aguardando');
    await send([{ ...base, state: 'idle', queued: 0, sequence: 1_000_002 }]);
    await expect(page.getByTestId('terminal-state-S')).toContainText('ocioso');
    await expect(page.getByTestId('terminal-state-S')).not.toContainText('na fila');
  } finally { await app.close(); }
});
