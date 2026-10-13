import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

test('salva o padrão Codex e preenche os argumentos de um novo terminal', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-codex').fill('--model "modelo de teste"');
    await page.getByTestId('settings-submit').click();
    await expect(page.getByRole('dialog', { name: 'Padrões dos agentes' })).toHaveCount(0);
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-codex')).toHaveValue('--model "modelo de teste"');
    await page.screenshot({ path: 'test-results/codex-settings.png' });
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByTestId('palette-new-terminal').click();
    await page.getByTestId('agent-codex').check();
    await expect(page.getByTestId('new-terminal-args')).toHaveValue('--model "modelo de teste"');
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  } finally { await app.close(); }
});
