import { expect, test } from '@playwright/test';
import { launchApp, screenOf } from './launch';

test('cria um shell com argumentos e edita os argumentos, relançando', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  await expect(page.locator('.proj.is-on')).toBeVisible();

  await page.getByTestId('palette-new-terminal').click();
  await page.getByTestId('agent-shell').check();
  await page.getByTestId('new-terminal-name').fill('S1');
  await page.getByTestId('new-terminal-args').fill('-NoExit -Command "Write-Output arg-um"');
  await page.getByTestId('new-terminal-submit').click();
  await expect.poll(() => screenOf(page, 'S1'), { timeout: 30_000 }).toContain('arg-um');

  await page.getByTestId('terminal-header-S1').click();
  await page.getByTestId('ctx-edit').click();
  await expect(page.getByTestId('edit-terminal-args')).toHaveValue('-NoExit -Command "Write-Output arg-um"');
  await page.getByTestId('edit-terminal-args').fill('-NoExit -Command "Write-Output arg-dois"');
  await page.getByTestId('edit-terminal-submit').click();
  await expect.poll(() => screenOf(page, 'S1'), { timeout: 30_000 }).toContain('arg-dois');
  expect(await screenOf(page, 'S1')).not.toContain('arg-um');

  await app.close();
});
