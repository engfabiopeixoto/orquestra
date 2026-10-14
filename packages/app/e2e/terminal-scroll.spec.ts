import { expect, test, type Page } from '@playwright/test';
import { createShell, launchApp } from './launch';

type Snapshot = { baseY: number; viewportY: number; length: number; canvas: string };

/** Posição do viewport do xterm e transform do canvas do React Flow. */
async function snapshot(page: Page, name: string): Promise<Snapshot> {
  return page.evaluate((terminal) => {
    const active = window.__orqTerms![terminal]!.buffer.active;
    const viewport = document.querySelector('.react-flow__viewport') as HTMLElement;
    return { baseY: active.baseY, viewportY: active.viewportY, length: active.length, canvas: viewport.style.transform };
  }, name);
}

async function printLines(page: Page, name: string, count: number) {
  await page.getByTestId(`terminal-body-${name}`).click();
  await page.keyboard.type(`1..${count} | ForEach-Object { "linha $_" }`);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(({ terminal, last }) => {
    const buffer = window.__orqTerms![terminal]!.buffer.active;
    for (let index = buffer.length - 1; index >= 0; index--) if (buffer.getLine(index)?.translateToString(true) === `linha ${last}`) return true;
    return false;
  }, { terminal: name, last: count }), { timeout: 30_000 }).toBe(true);
  // Espera o shell terminar de desenhar o prompt: a saída que chega durante a rolagem devolve o viewport ao fim.
  let previous = -1;
  await expect.poll(async () => { const { length } = await snapshot(page, name); const stable = length === previous; previous = length; return stable; }, { intervals: [400], timeout: 15_000 }).toBe(true);
}

async function wheelOverTerminal(page: Page, name: string, deltaY: number) {
  const box = (await page.getByTestId(`terminal-body-${name}`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(400);
}

// Causa: com zoom diferente de 100% a camada "duplo clique para interagir" cobre o terminal e não repassava a roda.
// O React Flow a tratava como roda sobre o canvas (panOnScroll): o canvas andava e o histórico ficava parado.
test('a roda sobre o terminal rola o histórico do xterm e não move o canvas, com zoom de 100% e fora dele', async () => {
  test.setTimeout(180_000);
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await printLines(page, 'S', 300);

    // 100%
    const full = await snapshot(page, 'S');
    expect(full.baseY).toBeGreaterThan(200);
    await wheelOverTerminal(page, 'S', -400);
    const afterFull = await snapshot(page, 'S');
    expect(afterFull.viewportY).toBeLessThan(full.viewportY);
    expect(afterFull.canvas).toBe(full.canvas);
    await page.evaluate(() => window.__orqTerms!.S!.scrollToBottom());

    // Fora de 100%: o terminal fica somente leitura, mas o histórico continua navegável.
    await page.getByRole('button', { name: 'Diminuir zoom' }).click();
    await expect(page.locator('.term-readonly')).toBeVisible();
    await page.waitForTimeout(300);
    const zoomed = await snapshot(page, 'S');
    expect(zoomed.viewportY).toBe(zoomed.baseY);
    await wheelOverTerminal(page, 'S', -400);
    const afterZoomed = await snapshot(page, 'S');
    expect(afterZoomed.viewportY).toBeLessThan(zoomed.viewportY);
    expect(afterZoomed.canvas).toBe(zoomed.canvas);
    // Continua somente leitura: a roda não digita nada no shell.
    expect(afterZoomed.baseY).toBe(zoomed.baseY);

    // Ctrl+roda continua sendo o zoom do canvas, mesmo sobre o terminal.
    await page.keyboard.down('Control');
    await wheelOverTerminal(page, 'S', 300);
    await page.keyboard.up('Control');
    expect((await snapshot(page, 'S')).canvas).not.toBe(afterZoomed.canvas);
  } finally { await app.close(); }
});
