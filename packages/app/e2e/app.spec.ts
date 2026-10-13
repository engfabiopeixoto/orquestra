import { expect, test } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

test('abre o projeto, cria shells, digita, conecta e fecha sem travar', async () => {
  const { app, page } = await launchApp();
  await expect(page.locator('.proj.is-on')).toBeVisible();

  await createShell(page, 'S1');
  await page.getByTestId('terminal-body-S1').click();
  await page.keyboard.type('echo e2e-ok');
  await page.keyboard.press('Enter');
  await expect.poll(() => screenOf(page, 'S1'), { timeout: 15_000 })
    .toContain('e2e-ok');

  await createShell(page, 'S2');
  await page.mouse.click(5, 5);
  await page.getByTestId('palette-connect').click();
  await page.getByTestId('terminal-header-S1').click();
  await page.getByTestId('terminal-header-S2').click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // Interface recarregada: reabrir a mesma pasta traz de volta os terminais vivos e a conexão.
  await page.reload();
  // Vivo, não necessariamente ocioso: o Enter do echo abriu um turno do usuário (volta a ocioso após 5 s sem saída).
  await expect(page.getByTestId('terminal-state-S1')).toBeVisible();
  await expect(page.getByTestId('terminal-state-S1')).not.toContainText('encerrado');
  await expect(page.getByTestId('terminal-state-S2')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  const startedAt = Date.now();
  await app.close();
  expect(Date.now() - startedAt).toBeLessThan(15_000);
});
