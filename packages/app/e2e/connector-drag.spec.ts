import { expect, test } from '@playwright/test';
import { createShell, launchApp } from './launch';

test('conectores do terminal são semicírculos internos e aceitam arraste a partir da borda', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await createShell(page, 'T');

    const geometry = await page.locator('[data-id="S"] .react-flow__handle-right').evaluate((handle) => {
      const rect = handle.getBoundingClientRect();
      const card = handle.closest('[data-id="S"]')!.querySelector('.term-node')!.getBoundingClientRect();
      const x = card.right + 6;
      const y = rect.top + rect.height / 2;
      return {
        width: rect.width,
        height: rect.height,
        insideCard: rect.left >= card.left && rect.right <= card.right + 0.5,
        flushWithBorder: Math.abs(rect.right - card.right) <= 1,
        hitTarget: document.elementFromPoint(x, y) === handle || handle.contains(document.elementFromPoint(x, y)),
      };
    });
    expect(geometry.width).toBe(7);
    expect(geometry.height).toBe(14);
    expect(geometry.insideCard).toBe(true);
    expect(geometry.flushWithBorder).toBe(true);
    expect(geometry.hitTarget).toBe(true);

    const source = await page.locator('[data-id="S"] .react-flow__handle-right').boundingBox();
    const target = await page.locator('[data-id="T"] .react-flow__handle-left').boundingBox();
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.react-flow__edge.orq-edge')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
