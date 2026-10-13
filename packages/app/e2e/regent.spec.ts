import { expect, test } from '@playwright/test';
import { launchApp, screenOf } from './launch';

test('um shell regente cria e conecta um terminal pelo orq', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  await expect(page.locator('.proj.is-on')).toBeVisible();

  await page.getByTestId('palette-new-terminal').click();
  await page.getByTestId('agent-shell').check();
  await page.getByTestId('new-terminal-name').fill('R');
  await page.getByTestId('new-terminal-regente').check();
  await page.getByTestId('new-terminal-submit').click();
  await expect(page.getByTestId('terminal-state-R')).toContainText('ocioso', { timeout: 30_000 });
  await expect(page.getByTestId('terminal-regente-R')).toBeVisible();

  await page.getByTestId('terminal-body-R').click();
  await page.keyboard.type('orq new S --agent shell');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-state-S')).toContainText('ocioso', { timeout: 30_000 });
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByText('R criou S.')).toBeVisible();

  await page.keyboard.type('orq unlink R S');
  await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect.poll(() => screenOf(page, 'R'), { timeout: 15_000 }).toContain('R e S desconectados');

  await app.close();
});
