import { expect, test } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

test('desfoca, bloqueia, duplica, descarrega e recarrega um terminal', async () => {
  test.setTimeout(120000);
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible({ timeout: 30000 });
    await createShell(page, 'S1');
    const menu = () => page.getByTestId('terminal-options-S1').click();
    await menu();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.screenshot({ path: 'test-results/terminal-options.png' });
    await page.getByTestId('ctx-blur').click();
    await expect(page.getByText('Conteúdo desfocado')).toBeVisible();
    await expect(page.locator('.term-content.is-blurred')).toHaveCount(1);
    await page.getByRole('button', { name: 'Mostrar conteúdo' }).click();
    await expect(page.locator('.term-content.is-blurred')).toHaveCount(0);
    await menu(); await page.getByTestId('ctx-lock').click();
    await expect(page.locator('.term-node.is-locked')).toHaveCount(1);
    const before = await page.getByTestId('terminal-header-S1').boundingBox();
    await page.mouse.move(before!.x + 30, before!.y + 10); await page.mouse.down();
    await page.mouse.move(before!.x + 140, before!.y + 110, { steps: 5 }); await page.mouse.up();
    const after = await page.getByTestId('terminal-header-S1').boundingBox();
    expect(after!.x).toBeCloseTo(before!.x); expect(after!.y).toBeCloseTo(before!.y);
    await menu(); await page.getByTestId('ctx-duplicate').click();
    await expect(page.getByTestId('terminal-header-S1-copia')).toBeVisible();
    await expect(page.getByTestId('terminal-state-S1-copia')).toContainText('ocioso', { timeout: 30000 });
    await menu(); await page.getByTestId('ctx-unload').click();
    await expect(page.getByTestId('terminal-state-S1')).toContainText('descarregado');
    await expect(page.getByTestId('terminal-unloaded-S1')).toBeVisible();
    await expect(page.getByTestId('terminal-body-S1')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('terminal-unloaded-S1')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.term-node.is-locked')).toHaveCount(1);
    await page.getByRole('button', { name: 'Recarregar terminal' }).click();
    await expect(page.getByTestId('terminal-state-S1')).toContainText('ocioso', { timeout: 30000 });
    await page.getByTestId('terminal-body-S1').click();
    await page.keyboard.type('echo recarregado-ok'); await page.keyboard.press('Enter');
    await expect.poll(() => screenOf(page, 'S1')).toContain('recarregado-ok');
  } finally { await app.close(); }
});
