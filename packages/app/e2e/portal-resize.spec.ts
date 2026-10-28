import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

let server: Server;
let url = '';

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body><h1>Portal stable viewport</h1><script>document.body.dataset.viewport = `${innerWidth}x${innerHeight}`</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') url = `http://127.0.0.1:${address.port}`;
    resolve();
  }));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('mantém viewport lógico ao recortar e alterna snapshot/live durante pan e zoom', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.app')).toBeVisible();
    await page.getByTestId('palette-new-portal').click();
    await page.getByTestId('portal-url-input').fill(url);
    await page.getByTestId('portal-btn-go').click();
    await expect.poll(() => app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'));
      return wc ? wc.executeJavaScript('document.body.innerText') : '';
    })).toContain('Portal stable viewport');
    const canvasBox = await page.locator('.canvas').boundingBox();
    await page.mouse.click(canvasBox!.x + canvasBox!.width - 16, canvasBox!.y + canvasBox!.height / 2);
    await page.waitForTimeout(200);
    const portalTestId = await page.locator('[data-testid^="portal-node-"]').getAttribute('data-testid');
    const portalId = portalTestId!.slice('portal-node-'.length);

    const inspect = () => app.evaluate(async ({ webContents, BrowserWindow }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'));
      if (!wc) return null;
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find((child) => (child as any).webContents?.id === wc.id) as any;
      return { visible: view?.getVisible(), bounds: view?.getBounds(), page: await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })') };
    });
    await expect.poll(async () => (await inspect())?.visible).toBe(true);
    const initial = await inspect();
    const width = initial!.page.width;

    const transform = await page.evaluate(() => {
      const portal = document.querySelector<HTMLElement>('.portal-node')!;
      const body = portal.querySelector<HTMLElement>('.portal-view-container')!;
      const canvas = document.querySelector<HTMLElement>('.canvas')!;
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const originalTransform = getComputedStyle(viewport).transform;
      const matrix = new DOMMatrix(originalTransform);
      const rect = body.getBoundingClientRect();
      const visible = canvas.getBoundingClientRect();
      const dx = visible.left - rect.left - rect.width / 2;
      viewport.style.transform = `translate(${matrix.e + dx}px, ${matrix.f}px) scale(${matrix.a})`;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      return originalTransform;
    });
    await expect(page.getByTestId(`portal-snapshot-${portalId}`)).toBeVisible();
    await expect.poll(async () => (await inspect())?.visible).toBe(false);
    expect((await inspect())?.page.width).toBe(width);

    await page.evaluate((value) => {
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      viewport.style.transform = value;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    }, transform);
    await expect.poll(async () => (await inspect())?.visible).toBe(true);
    expect((await inspect())?.page.width).toBe(width);

    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 500);
    await page.keyboard.up('Control');
    await expect(page.getByTestId('zoom-level')).toHaveText('50%');
    await expect(page.getByTestId(`portal-live-hint-${portalId}`)).toBeVisible();
    await expect.poll(async () => (await inspect())?.visible).toBe(false);
    await page.getByTestId(`portal-snapshot-${portalId}`).dblclick();
    await expect(page.getByTestId('zoom-level')).toHaveText('100%', { timeout: 5_000 });
    await expect.poll(async () => (await inspect())?.visible).toBe(true);
    expect((await inspect())?.page.width).toBe(width);
  } finally {
    await app.close();
  }
});
