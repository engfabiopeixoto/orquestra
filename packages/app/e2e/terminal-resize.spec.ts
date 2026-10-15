import { expect, test } from '@playwright/test';
import { createShell, launchApp } from './launch';

test('o canto do terminal selecionado redimensiona o card, sem ser coberto por ele', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await page.getByTestId('terminal-header-S').click();
    const corner = page.locator('[data-id="S"] .react-flow__resize-control.handle.bottom.right');
    await expect(corner).toBeVisible();

    // O ponto um pixel para dentro do card, sobre o quadradinho do canto, tem de acertar o controle e não o card.
    const hitsCorner = await corner.evaluate((handle) => {
      const rect = handle.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + 1, rect.top + 1);
      return target === handle || handle.contains(target);
    });
    expect(hitsCorner).toBe(true);

    // A borda direita, 3px para dentro do card e longe do conector do meio, também redimensiona.
    const edgeHit = await page.evaluate(() => {
      const node = document.querySelector('[data-id="S"]')!;
      const rect = node.querySelector('.term-node')!.getBoundingClientRect();
      const target = document.elementFromPoint(rect.right - 3, rect.top + rect.height / 4);
      return target?.closest('.react-flow__resize-control.line.right') !== null;
    });
    expect(edgeHit).toBe(true);
    const cornerSize = await corner.evaluate((handle) => handle.getBoundingClientRect().width);
    expect(cornerSize).toBe(8);

    const card = page.locator('[data-id="S"] .term-node');
    const before = await card.boundingBox();
    const box = await corner.boundingBox();
    await page.mouse.move(box!.x + 1, box!.y + 1);
    await page.mouse.down();
    await page.mouse.move(box!.x + 81, box!.y + 61, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(before!.width + 40);
  } finally {
    await app.close();
  }
});
