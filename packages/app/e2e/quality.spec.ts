import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

test('painel de Qualidade à direita recolhe/abre, mede ciclo e sincroniza o sinal', async () => {
  const project = mkdtempSync(join(tmpdir(), 'orq-quality-e2e-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
  writeFileSync(join(project, 'src', 'b.ts'), "import { a } from './a';\nexport const b = () => a;\n");

  const { app, page } = await launchApp({ project });
  try {
    await expect(page.getByTestId('sidebar-tab-quality')).toHaveCount(0);

    const toggle = page.getByTestId('quality-drawer-toggle');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    const canvasBefore = await page.locator('.canvas').boundingBox();
    await toggle.click();

    const drawer = page.getByTestId('quality-drawer');
    await expect(drawer).toBeVisible();
    const drawerBox = await drawer.boundingBox();
    const canvasAfter = await page.locator('.canvas').boundingBox();
    expect(drawerBox!.x).toBeGreaterThanOrEqual(canvasAfter!.x + canvasAfter!.width - 1);
    expect(canvasAfter!.width).toBeLessThan(canvasBefore!.width);

    await page.getByTestId('quality-measure').click();
    const depsCard = page.getByTestId('quality-card-dependencies');
    await expect(depsCard).toContainText('PROBLEMA', { timeout: 30_000 });
    await expect(depsCard).toContainText('1');

    // Recolhe e confirma o ponto vermelho na faixa
    await page.getByTestId('quality-drawer-collapse').click();
    await expect(toggle).toBeVisible();
    await expect(toggle.locator('.quality-signal-dot')).toHaveClass(/is-bad/);

    // Simula ABNT2 AltGr+Q (key '/') — não deve abrir o painel
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'KeyQ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    });
    await expect(toggle).toBeVisible();

    // Atalho Ctrl+Shift+Q alterna abertura
    await page.keyboard.press('Control+Shift+q');
    await expect(page.getByTestId('quality-drawer-collapse')).toBeVisible();
  } finally {
    await app.close();
  }
});
