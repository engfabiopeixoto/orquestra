import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createShell, launchApp } from './launch';

type Snap = { baseY: number; viewportY: number; length: number; type: string; canvas: string };
const snap = (page: Page): Promise<Snap> => page.evaluate(() => {
  const active = window.__orqTerms!.S!.buffer.active;
  return { baseY: active.baseY, viewportY: active.viewportY, length: active.length, type: active.type, canvas: (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform };
});
const stable = async (page: Page) => {
  let previous = -1;
  await expect.poll(async () => { const { length } = await snap(page); const same = length === previous; previous = length; return same; }, { intervals: [400], timeout: 20_000 }).toBe(true);
};
const wheel = async (page: Page, deltaY = -400) => {
  const box = (await page.getByTestId('terminal-body-S').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
};
const report = (label: string, before: Snap, after: Snap) =>
  console.log(`RESULTADO ${label}: viewportY ${before.viewportY}->${after.viewportY} baseY ${before.baseY}->${after.baseY} canvasMoveu=${before.canvas !== after.canvas}`);

test('intermitente: reanexar, trocar de workspace e saida continua', async () => {
  test.setTimeout(300_000);
  const { app, page, project } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await page.getByTestId('terminal-body-S').click();
    await page.keyboard.type('1..300 | ForEach-Object { "linha $_" }');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snap(page)).baseY, { timeout: 30_000 }).toBeGreaterThan(250);
    await stable(page);

    // A. reanexar: o historico sobrevive e a roda rola
    const beforeReload = await snap(page);
    await page.reload();
    await expect(page.getByTestId('terminal-body-S')).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.__orqTerms?.S?.buffer.active.baseY ?? -1)), { timeout: 30_000 }).toBeGreaterThan(100);
    await stable(page);
    const afterReload = await snap(page);
    console.log(`A historico apos reanexar: baseY ${beforeReload.baseY} -> ${afterReload.baseY}`);
    await wheel(page);
    await page.waitForTimeout(500);
    report('A reanexar', afterReload, await snap(page));
    await page.evaluate(() => window.__orqTerms!.S!.scrollToBottom());

    // B. trocar de workspace e voltar
    const other = mkdtempSync(join(tmpdir(), 'orq-intermitente-B-'));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, other);
    await page.getByTestId('open-project').click();
    await expect(page.getByTestId(`workspace-${basename(other)}`)).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(`workspace-${basename(project)}`).click();
    await expect(page.getByTestId(`workspace-${basename(project)}`)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await page.evaluate(() => window.__orqTerms?.S?.buffer.active.baseY ?? -1)), { timeout: 30_000 }).toBeGreaterThan(100);
    await stable(page);
    const afterSwitch = await snap(page);
    console.log(`B historico apos trocar de workspace: baseY ${afterSwitch.baseY}`);
    await wheel(page);
    await page.waitForTimeout(500);
    report('B trocar workspace', afterSwitch, await snap(page));
    await page.evaluate(() => window.__orqTerms!.S!.scrollToBottom());

    // C. rolar durante saida continua (terminal "ocupado")
    await page.getByTestId('terminal-body-S').click();
    await page.keyboard.type('1..300 | ForEach-Object { "fluxo $_"; Start-Sleep -Milliseconds 40 }');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const streaming = await snap(page);
    await wheel(page, -300);
    const samples: string[] = [];
    for (const wait of [50, 250, 700, 1500, 2500]) {
      await page.waitForTimeout(wait);
      const current = await snap(page);
      samples.push(`${current.viewportY}/${current.baseY}`);
    }
    console.log(`RESULTADO C saida continua: antes ${streaming.viewportY}/${streaming.baseY}; depois (viewportY/baseY) ${samples.join(' ')}`);
    // D. varias rodas seguidas durante a saida
    for (let index = 0; index < 5; index++) { await wheel(page, -120); await page.waitForTimeout(150); }
    const many = await snap(page);
    console.log(`RESULTADO D 5 rodas durante a saida: viewportY ${many.viewportY}/baseY ${many.baseY}`);
  } finally { await app.close(); }
});
