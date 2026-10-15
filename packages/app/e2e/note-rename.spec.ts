import { expect, test } from '@playwright/test';
import { createShell, launchApp } from './launch';

test('renomear nota pelo título preserva a conexão e Esc cancela', async () => {
  test.setTimeout(120_000);
  const app = await launchApp();
  try {
    const { page } = app;
    await createShell(page, 'S');
    await page.getByTestId('palette-new-note').click();
    await expect(page.getByTestId('note-nota-1')).toBeVisible();
    await page.getByTestId('palette-connect').click();
    await page.getByTestId('terminal-header-S').click();
    await page.getByTestId('note-nota-1').click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.locator('[data-testid="note-nota-1"] .note-name').dblclick();
    const editor = page.getByTestId('note-name-input');
    await expect(editor).toBeFocused();
    await editor.fill('plano');
    await editor.press('Enter');
    await expect(page.getByTestId('note-plano')).toBeVisible();
    await expect(page.getByTestId('note-nota-1')).toHaveCount(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.locator('[data-testid="note-plano"] .note-name').dblclick();
    await expect(editor).toBeFocused();
    await editor.fill('descartar');
    await editor.press('Escape');
    await expect(page.getByTestId('note-plano')).toBeVisible();
    await expect(page.locator('[data-testid="note-plano"] .note-name')).toHaveText('plano');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  } finally {
    await app.app.close();
  }
});
