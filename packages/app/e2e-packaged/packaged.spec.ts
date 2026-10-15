import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

async function screenOf(page: Page, name: string): Promise<string> {
  const response = await page.evaluate((terminal) => window.orquestra.invoke('terminal.snapshot', { name: terminal }), name);
  return response.ok ? (response.result as { data: string }).data : '';
}

test('app empacotado abre, inicia o núcleo, cria shell e grava logs', async () => {
  test.setTimeout(120_000);

  const executablePath = join(__dirname, '../release/win-unpacked/Orquestra.exe');
  expect(existsSync(executablePath), `Executável não encontrado em ${executablePath}`).toBe(true);

  const project = mkdtempSync(join(tmpdir(), 'orq-pkg-proj-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'orq-pkg-data-'));
  const binDir = mkdtempSync(join(tmpdir(), 'orq-pkg-bin-'));
  const pipePath = `\\\\.\\pipe\\orq-pkg-${randomBytes(4).toString('hex')}`;

  const app = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      ORQ_E2E_PROJECT: project,
      ORQ_DATA_DIR: dataDir,
      ORQ_BIN_DIR: binDir,
      ORQ_PIPE_PATH: pipePath,
    },
  });

  const page = await app.firstWindow();
  try {
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe('0.3.8');
  await expect(page.locator('.proj.is-on')).toBeVisible({ timeout: 30_000 });

  // Cria um shell
  await page.getByTestId('palette-new-terminal').click();
  await page.getByTestId('agent-shell').check();
  await page.getByTestId('new-terminal-name').fill('S1');
  await page.getByTestId('new-terminal-submit').click();
  await expect(page.getByTestId('terminal-state-S1')).toContainText('ocioso', { timeout: 30_000 });

  // Executa um comando real para conferir que o ConPTY e o shell funcionam de ponta a ponta
  await page.getByTestId('terminal-body-S1').click();
  await page.keyboard.type('echo pkg-ok');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await screenOf(page, 'S1')).match(/pkg-ok/g)?.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  // The packaged renderer and host both expose the new group contract.
  await page.getByTestId('palette-new-group').click();
  await page.getByTestId('group-title').fill('Equipe empacotada');
  await page.getByTestId('group-submit').click();
  await expect(page.getByTestId('group-header-Equipe empacotada')).toBeVisible();
  await page.getByTestId('group-header-Equipe empacotada').click({ button: 'right', position: { x: 70, y: 20 } });
  await page.getByTestId('group-manage-members').click();
  await page.getByTestId('group-member-S1').check();
  await page.getByTestId('group-members-submit').click();
  await expect(page.getByTestId('group-header-Equipe empacotada')).toContainText('1 elemento');
  await page.getByTestId('group-header-Equipe empacotada').click({ button: 'right', position: { x: 70, y: 20 } });
  await page.getByTestId('group-ungroup').click();
  await expect(page.locator('.group-frame')).toHaveCount(0);
  await expect(page.getByTestId('terminal-body-S1')).toBeVisible();
  await page.getByTestId('flow-library').click(); await page.getByTestId('flow-example').click();
  await page.getByRole('button', { name: 'Enquadrar', exact: true }).click(); await page.getByTestId('flow-run').click();
  await expect.poll(async () => { const response = await page.evaluate(() => window.orquestra.invoke('flow.get', {})); return response.ok ? (response.result as any).run?.status : 'error'; }).toBe('success');
  await page.getByRole('button', { name: 'Abrir prévia 3D', exact: true }).click(); await expect(page.getByTestId('flow-3d').locator('canvas')).toBeVisible(); await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByTestId('palette-new-portal').click(); await expect(page.locator('.portal-node')).toBeVisible();
  const portalId = (await page.locator('.portal-node').getAttribute('data-testid'))!.slice('portal-node-'.length);
  await page.evaluate((id) => window.orquestra.invoke('edge.connect', { a: 'S1', b: id }), portalId);
  await page.evaluate(() => window.orquestra.invoke('terminal.input', { name: 'S1', data: 'orq portal list --json\r' }));
  await expect.poll(() => screenOf(page, 'S1')).toContain(portalId);
  await page.getByTestId('portal-mode-mobile').click(); await expect(page.locator('.portal-node')).toHaveClass(/is-mobile-frame/); await page.getByTestId('portal-close').click(); await expect(page.locator('.portal-node')).toHaveCount(0);
  } finally { await app.close(); }

  // Confere que ORQ_DATA_DIR/logs tem os arquivos orquestra-app*.log e orquestra*.log
  const logDir = join(dataDir, 'logs');
  expect(existsSync(logDir), `Diretório de logs não encontrado em ${logDir}`).toBe(true);
  const logFiles = readdirSync(logDir);

  const hasAppLog = logFiles.some((file) => /^orquestra-app.*\.log$/.test(file));
  const hasHostLog = logFiles.some((file) => /^orquestra(?!-app).*\.log$/.test(file));

  expect(hasAppLog, `Arquivo orquestra-app*.log não encontrado em ${logDir}: ${logFiles.join(', ')}`).toBe(true);
  expect(hasHostLog, `Arquivo orquestra*.log (host) não encontrado em ${logDir}: ${logFiles.join(', ')}`).toBe(true);
});
