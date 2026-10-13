import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

let server: Server;
let serverUrl = '';

test.beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Portal E2E Test Server</title>
          </head>
          <body>
            <h1>Portal Local Server</h1>
            <p id="user-agent"></p>
            <script>
              document.getElementById('user-agent').innerText = navigator.userAgent;
            </script>
          </body>
        </html>
      `);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        serverUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
});

test('portal libera páginas ao fechar workspace e restaura abas e mobile ao reabrir a pasta e o app', async () => {
  test.setTimeout(120000); const first = await launchApp();
  const open = async (path: string) => { await first.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path); await first.page.getByTestId('open-project').click(); await expect(first.page.getByTestId(`workspace-${basename(path)}`)).toHaveAttribute('aria-selected', 'true'); };
  try {
    const page = first.page; await expect(page.locator('.proj.is-on')).toBeVisible(); await page.getByTestId('palette-new-portal').click();
    await page.getByTestId('portal-url-input').fill(`${serverUrl}/first`); await page.getByTestId('portal-btn-go').click();
    await page.getByTestId('portal-new-tab').click(); await expect(page.locator('.portal-tab-item')).toHaveCount(2);
    await page.getByTestId('portal-url-input').fill(`${serverUrl}/second`); await page.getByTestId('portal-btn-go').click(); await page.getByTestId('portal-mode-mobile').click();
    await expect.poll(() => first.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((wc) => wc.getURL() === url), `${serverUrl}/second`)).toBe(true);
    await first.app.evaluate(async ({ webContents }, url) => { const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url)!; await wc.executeJavaScript('document.cookie="orq_portal_restore=yes; path=/; Max-Age=86400"'); }, `${serverUrl}/second`);
    const other = mkdtempSync(join(tmpdir(), 'orq-portal-other-')); await open(other); await expect(page.locator('.portal-node')).toHaveCount(0);
    await page.getByRole('button', { name: `Fechar workspace ${basename(first.project)}`, exact: true }).click();
    await expect.poll(() => first.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(url)).length, serverUrl)).toBe(0);
    await open(first.project); await expect(page.locator('.portal-node')).toHaveClass(/is-mobile-frame/); await expect(page.locator('.portal-tab-item')).toHaveCount(2); await expect(page.getByTestId('portal-url-input')).toHaveValue(`${serverUrl}/second`);
    await expect.poll(() => first.app.evaluate(async ({ webContents }, url) => { const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url); return wc ? wc.executeJavaScript('document.cookie') : ''; }, `${serverUrl}/second`)).toContain('orq_portal_restore=yes');
  } finally { await first.app.close(); }
  const restored = await launchApp({ project: first.project, dataDir: first.dataDir, binDir: first.binDir });
  try { await expect(restored.page.locator('.portal-node')).toHaveClass(/is-mobile-frame/); await expect(restored.page.locator('.portal-tab-item')).toHaveCount(2); await expect(restored.page.getByTestId('portal-url-input')).toHaveValue(`${serverUrl}/second`); await expect.poll(() => restored.app.evaluate(async ({ webContents }, url) => { const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url); return wc ? wc.executeJavaScript('document.cookie') : ''; }, `${serverUrl}/second`)).toContain('orq_portal_restore=yes'); }
  finally { await restored.app.close(); }
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
});

test('Portal de Navegador: criação via Palette, navegação desktop e mobile, drag/bounds, ocultação por modal, persistência e fechamento', async () => {
  test.setTimeout(90_000);
  const { app, page } = await launchApp();

  try {
    // 1. Aguarda inicialização do app com o projeto aberto
    await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.palette')).toBeVisible();

    // 2. Criação via Palette: clica em "+ Portal"
    const portalButton = page.getByTestId('palette-new-portal');
    await expect(portalButton).toBeVisible();
    await expect(portalButton).toBeEnabled();
    await portalButton.click();

    // 3. Verifica que o nó do portal aparece no Canvas
    const portalNode = page.locator('[data-testid^="portal-node-"]');
    await expect(portalNode).toBeVisible({ timeout: 15_000 });

    // 4. Navegação contra servidor local
    const urlInput = page.getByTestId('portal-url-input');
    await expect(urlInput).toBeVisible();
    await urlInput.fill(serverUrl);
    await page.getByTestId('portal-btn-go').click();
    const inspect = () => app.evaluate(async ({ webContents, BrowserWindow }, targetUrl) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(targetUrl));
      if (!wc) return null;
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find((view) => (view as any).webContents?.id === wc.id);
      return { id: wc.id, visible: view?.getVisible(), bounds: view?.getBounds(), page: await wc.executeJavaScript('({width:innerWidth,height:innerHeight,ua:navigator.userAgent,touch:navigator.maxTouchPoints,bridge:typeof window.orquestra,title:document.title})') };
    }, serverUrl);
    await expect.poll(async () => (await inspect())?.page.title).toBe('Portal E2E Test Server');
    expect((await inspect())?.page.bridge).toBe('undefined');

    // 5. Alterna para modo Mobile responsivo
    const mobileBtn = page.getByTestId('portal-mode-mobile');
    await mobileBtn.click();
    await expect(portalNode).toHaveClass(/is-mobile-frame/);
    await expect.poll(async () => (await inspect())?.page.width).toBe(393);
    await expect.poll(async () => (await inspect())?.page.touch).toBe(1);
    expect((await inspect())?.page.ua).toContain('iPhone');

    // Seletor de preset mobile e rotação
    const presetSelect = page.getByTestId('portal-preset-select');
    await expect(presetSelect).toBeVisible();
    await expect(presetSelect).toHaveValue('iphone-15-pro');

    const rotateBtn = page.getByTestId('portal-btn-rotate');
    await expect(rotateBtn).toBeVisible();
    await rotateBtn.click();
    await expect.poll(async () => (await inspect())?.page.width).toBe(852);

    // Retorna para modo Desktop
    const desktopBtn = page.getByTestId('portal-mode-desktop');
    await desktopBtn.click();
    await expect(portalNode).not.toHaveClass(/is-mobile-frame/);
    await expect.poll(async () => (await inspect())?.page.touch).toBe(0);
    expect((await inspect())?.page.ua).not.toContain('iPhone');

    // 6. Bounds acompanhando movimentação / drag no canvas
    const header = portalNode.locator('.portal-header');
    const beforeBox = await header.boundingBox();
    expect(beforeBox).not.toBeNull();

    await page.mouse.move(beforeBox!.x + 30, beforeBox!.y + 10);
    await page.mouse.down();
    await page.mouse.move(beforeBox!.x + 120, beforeBox!.y + 80, { steps: 5 });
    await page.mouse.up();

    const afterBox = await header.boundingBox();
    expect(afterBox).not.toBeNull();
    expect(afterBox!.x).not.toBeCloseTo(beforeBox!.x, 0);

    // 7. Ocultação ao abrir modal e restauração ao fechar
    await page.getByTestId('palette-new-terminal').click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await inspect())?.visible).toBe(false);

    // Fecha o modal
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(portalNode).toBeVisible();
    await expect.poll(async () => (await inspect())?.visible).toBe(true);

    // 8. Persistência do nó e estado após reload da página
    await page.reload();
    await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 });
    const reloadedPortal = page.locator('[data-testid^="portal-node-"]');
    await expect(reloadedPortal).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('portal-url-input')).toHaveValue(`${serverUrl}/`);
    await expect.poll(async () => (await inspect())?.visible).toBe(true);

    // 9. Fechamento do portal e descarte
    const closeBtn = page.getByTestId('portal-close');
    await closeBtn.click();
    await expect(page.locator('[data-testid^="portal-node-"]')).toHaveCount(0);
    await expect.poll(inspect).toBeNull();
  } finally {
    // 10. Encerramento limpo sem processos órfãos
    const closeStart = Date.now();
    await app.close();
    expect(Date.now() - closeStart).toBeLessThan(15_000);
  }
});
