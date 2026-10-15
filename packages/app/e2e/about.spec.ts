import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

const appVersion = (JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }).version;

test('menu Sobre mostra a versão do app', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await page.getByRole('button', { name: 'Menu do Orquestra' }).click();
    await page.getByRole('menuitem', { name: 'Sobre o Orquestra' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sobre o Orquestra' });
    await expect(dialog).toContainText(`Versão ${appVersion}`);
    await expect(dialog.getByRole('button', { name: 'Ver no GitHub' })).toBeVisible();
  } finally {
    await app.close();
  }
});
