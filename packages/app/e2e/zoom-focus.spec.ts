import { expect, test } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

test('duplo clique na camada de zoom restaura foco sem clique extra', async () => {
  const { app, page } = await launchApp();
  await expect(page.locator('.proj.is-on')).toBeVisible();

  await createShell(page, 'S1');
  await page.getByTestId('terminal-body-S1').click();

  // Dá zoom com Ctrl+roda sobre o terminal (o corpo tem nowheel para scroll interno do shell)
  await page.getByTestId('terminal-header-S1').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');

  // Camada "duplo clique para interagir" deve aparecer
  const readonlyLayer = page.locator('.term-readonly');
  await expect(readonlyLayer).toBeVisible({ timeout: 10_000 });

  // Duplo clique na camada volta a 100% e foca o terminal
  await readonlyLayer.dblclick();
  await expect(readonlyLayer).toBeHidden({ timeout: 10_000 });

  // Digita diretamente sem clicar de novo: confere comando + saída (pelo menos duas ocorrências)
  await page.keyboard.type('echo zoom-ok');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await screenOf(page, 'S1')).match(/zoom-ok/g)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  // 2. Mudar o zoom novamente: enquanto zoom != 100%, nada chega ao terminal (só-leitura)
  await page.getByTestId('terminal-header-S1').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await expect(readonlyLayer).toBeVisible({ timeout: 10_000 });

  await page.keyboard.type('echo ignorado');
  await page.keyboard.press('Enter');

  // Volta a 100% pelo atalho Ctrl+0 do canvas
  await page.keyboard.press('Control+0');
  await expect(readonlyLayer).toBeHidden({ timeout: 10_000 });

  // Confere que 'ignorado' não foi enviado ao terminal durante o só-leitura
  const snapshot = await screenOf(page, 'S1');
  expect(snapshot).not.toContain('ignorado');

  // Continua recebendo digitação sem clique extra: confere comando + saída
  await page.keyboard.type('echo ctrl0-ok');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await screenOf(page, 'S1')).match(/ctrl0-ok/g)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  await app.close();
});
