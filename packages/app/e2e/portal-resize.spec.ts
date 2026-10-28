import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

let server: Server;
let url = '';

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body style="margin:0;background:#ff00ff"><h1>Portal stable viewport</h1><script>document.body.dataset.viewport = `${innerWidth}x${innerHeight}`</script></body></html>');
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

test('mantém o portal vivo e o viewport CSS estável ao recortar e aplicar zoom', async () => {
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
    const initial = await app.evaluate(async ({ webContents, BrowserWindow }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'))!;
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.flatMap((child: any) => [child, ...(child.children ?? [])]).find((child: any) => child.webContents?.id === wc.id) as any;
      return { width: await wc.executeJavaScript('innerWidth'), bounds: view.getBounds() };
    });
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom };
      };
      return { canvas: rect('.canvas'), sidebar: rect('.side'), body: rect('.portal-view-container') };
    });
    const sidebarSample = { x: Math.floor(geometry.sidebar.right - 100), y: Math.floor(geometry.body.y + 20) };
    const sidebarBefore = await app.evaluate(async ({ BrowserWindow }, point) => {
      const image = await BrowserWindow.getAllWindows()[0]!.capturePage({ ...point, width: 1, height: 1 });
      return [...image.toBitmap().subarray(0, 4)];
    }, sidebarSample);

    await page.evaluate((rects) => {
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const body = document.querySelector<HTMLElement>('.portal-view-container')!.getBoundingClientRect();
      const dx = rects.canvas.x - body.x - body.width / 2;
      viewport.style.transform = `translate(${matrix.e + dx}px, ${matrix.f}px) scale(${matrix.a})`;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    }, geometry);

    const inspect = () => app.evaluate(async ({ webContents, BrowserWindow }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'));
      if (!wc) return null;
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.flatMap((child: any) => [child, ...(child.children ?? [])]).find((child: any) => child.webContents?.id === wc.id) as any;
      return { visible: view?.getVisible(), bounds: view?.getBounds(), page: await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })'), zoomFactor: wc.getZoomFactor() };
    });
    await expect(page.locator('.portal-snapshot, .portal-live-hint')).toHaveCount(0);
    await expect.poll(async () => (await inspect())?.visible).toBe(true);
    const clipped = await inspect();
    expect(clipped?.bounds.x).toBeLessThan(0);
    expect(clipped?.page.width).toBe(initial.width);
    expect(clipped?.bounds.width).toBe(initial.bounds.width);
    const sidebarAfter = await app.evaluate(async ({ BrowserWindow }, point) => {
      const image = await BrowserWindow.getAllWindows()[0]!.capturePage({ ...point, width: 1, height: 1 });
      return [...image.toBitmap().subarray(0, 4)];
    }, sidebarSample);
    expect(sidebarAfter).toEqual(sidebarBefore);

    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 500);
    await page.keyboard.up('Control');
    await expect(page.getByTestId('zoom-level')).toHaveText('50%');
    await expect.poll(async () => (await inspect())?.visible).toBe(true);
    const zoomed = await inspect();
    expect(zoomed?.zoomFactor).toBeCloseTo(0.5);
    expect(zoomed?.page.width).toBe(initial.width);
    expect(zoomed?.bounds.width).toBeCloseTo(initial.bounds.width / 2, 0);
  } finally {
    await app.close();
  }
});

test('a moldura deixa os controles flutuantes do canvas clicáveis', async () => {
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
    const canvas = await page.locator('.canvas').boundingBox();
    await page.mouse.click(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
    await expect(page.locator('.portal-view-container')).toBeVisible();

    const geometry = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.portal-view-container')!.getBoundingClientRect();
      const palette = document.querySelector<HTMLElement>('.palette')!.getBoundingClientRect();
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const dx = palette.left + palette.width / 2 - (body.left + body.width / 2);
      const dy = palette.bottom - 20 - body.top;
      viewport.style.transform = `translate(${matrix.e + dx}px, ${matrix.f + dy}px) scale(${matrix.a})`;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      return { paletteBottom: palette.bottom };
    });
    const frameBounds = () => app.evaluate(({ BrowserWindow, webContents }) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'))!;
      const frame = BrowserWindow.getAllWindows()[0]!.contentView.children.find((view: any) =>
        view.children?.some((child: any) => child.webContents?.id === wc.id),
      ) as any;
      return frame?.getBounds();
    });
    await expect.poll(async () => (await frameBounds()).y).toBeGreaterThan(geometry.paletteBottom);
    await page.getByTestId('palette-new-note').click();
    await expect(page.locator('.note-node')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
