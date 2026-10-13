import { expect, test, type Page } from '@playwright/test';
import { createShell, launchApp } from './launch';

async function endpoints(page: Page) {
  const path = await page.locator('.react-flow__edge-path').getAttribute('d');
  const numbers = path?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  return { start: numbers.slice(0, 2), end: numbers.slice(-2) };
}

async function anchor(page: Page, name: string, side: 'left' | 'right' | 'top' | 'bottom') {
  return page.evaluate(({ name, side }) => {
    const handle = document.querySelector(`[data-id="${name}"] .react-flow__handle-${side}`)!.getBoundingClientRect();
    const canvas = document.querySelector('.react-flow')!.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
    const x = side === 'left' ? handle.left : side === 'right' ? handle.right : handle.left + handle.width / 2;
    const y = side === 'top' ? handle.top : side === 'bottom' ? handle.bottom : handle.top + handle.height / 2;
    return [(x - canvas.left - matrix.e) / matrix.a, (y - canvas.top - matrix.f) / matrix.d];
  }, { name, side });
}
async function expectSides(page: Page, source: 'right' | 'bottom', target: 'left' | 'top') {
  await expect.poll(async () => {
    const path = await endpoints(page);
    const start = await anchor(page, 'S', source), end = await anchor(page, 'nota-1', target);
    return Math.max(...path.start.map((value, index) => Math.abs(value - start[index]!)), ...path.end.map((value, index) => Math.abs(value - end[index]!)));
  }).toBeLessThan(1);
}

test('linha usa lados prÃ³ximos e troca para baixo/cima durante arraste e apÃ³s recarregar', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await page.getByTestId('palette-new-note').click();
    await expect(page.getByTestId('note-nota-1')).toBeVisible();
    await page.getByTestId('palette-connect').click();
    await page.getByTestId('terminal-header-S').click();
    await page.getByTestId('note-nota-1').locator('.note-hd').click();
    await expect(page.locator('.react-flow__edge-path')).toHaveCount(1);
    await expectSides(page, 'right', 'left');

    const header = (await page.getByTestId('note-nota-1').locator('.note-hd').boundingBox())!;
    await page.mouse.move(header.x + 50, header.y + 12);
    await page.mouse.down();
    await page.mouse.move(header.x + 50 - 680, header.y + 12 + 480, { steps: 12 });
    // Verify the switch while the mouse is still down, before layout persistence.
    await expectSides(page, 'bottom', 'top');
    await page.mouse.up();
    await page.reload();
    await expect(page.locator('.react-flow__edge-path')).toHaveCount(1);
    await expectSides(page, 'bottom', 'top');
  } finally { await app.close(); }
});

