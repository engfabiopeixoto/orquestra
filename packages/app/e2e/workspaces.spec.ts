import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

async function openFolder(app: ElectronApplication, page: Page, dir: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, dir);
  await page.getByTestId('open-project').click();
}

test('três projetos continuam trabalhando, quarta abertura é bloqueada e fechar libera vaga', async () => {
  test.setTimeout(180_000);
  const { app, page, project, dataDir } = await launchApp();
  try {
    await expect(page.getByRole('tab', { name: new RegExp(basename(project)) })).toBeVisible();
    await expect(page.getByTitle('Máximo de três workspaces simultâneos')).toHaveText('1/3');
    await expect(page.locator('.titlebar')).toBeVisible();
    await page.getByRole('button', { name: 'Menu do Orquestra' }).click();
    await expect(page.getByRole('menuitem')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await createShell(page, 'S');
    await expect(page.getByTestId(`workspace-${basename(project)}`)).toContainText('1 agentes');
    await page.getByTestId('terminal-header-S').click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await page.getByTestId('terminal-body-S').click();
    await page.keyboard.type('Start-Sleep -Seconds 2; Write-Output BACKGROUND-A');
    await page.keyboard.press('Enter');
    await page.getByTestId('terminal-header-S').click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    const b = mkdtempSync(join(tmpdir(), 'orq-multi-B-'));
    await openFolder(app, page, b);
    await expect(page.getByTestId(`workspace-${basename(b)}`)).toHaveAttribute('aria-selected', 'true');
    await createShell(page, 'S');
    await page.getByTestId('terminal-body-S').click();
    await page.keyboard.type('Write-Output APENAS-B');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenOf(page, 'S')).toContain('APENAS-B');

    const c = mkdtempSync(join(tmpdir(), 'orq-multi-C-'));
    await openFolder(app, page, c);
    await expect(page.getByTestId(`workspace-${basename(c)}`)).toHaveAttribute('aria-selected', 'true');
    await createShell(page, 'S');
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.locator('.react-flow')).toHaveCount(1);
    await expect(page.locator('.xterm')).toHaveCount(1);

    const d = mkdtempSync(join(tmpdir(), 'orq-multi-D-'));
    await openFolder(app, page, d);
    await expect(page.locator('.notices')).toContainText('Limite de 3 workspaces');
    await expect(page.getByRole('tab')).toHaveCount(3);

    await page.getByTestId(`workspace-${basename(project)}`).click();
    await expect.poll(() => screenOf(page, 'S')).toContain('BACKGROUND-A');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    expect(await screenOf(page, 'S')).not.toContain('APENAS-B');
    const registry = JSON.parse(readFileSync(join(dataDir, 'workspaces.json'), 'utf8'));
    const aId = registry.workspaces.find((workspace: { dir: string }) => workspace.dir === project).id;
    const bId = registry.workspaces.find((workspace: { dir: string }) => workspace.dir === b).id;
    await app.evaluate(({ BrowserWindow }, workspaceId) => BrowserWindow.getAllWindows()[0]!.webContents.send('orq:focus-terminal', 'S', workspaceId), bId);
    await expect(page.getByTestId(`workspace-${basename(b)}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.getByTestId(`workspace-${basename(project)}`).click();
    const pidsBefore = JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'));
    await page.reload();
    await expect(page.getByTestId('terminal-body-S')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(3);
    expect(JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'))).toEqual(pidsBefore);

    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: `Fechar workspace ${basename(project)}` }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByTestId('terminal-body-S')).toBeVisible();
    const closed = await page.evaluate((id) => window.orquestra.invoke('terminal.input', { name: 'S', data: 'errado' }, id), aId);
    expect(closed.ok).toBe(false);
    await page.getByTestId(`workspace-${basename(b)}`).click();
    await expect.poll(() => screenOf(page, 'S')).toContain('APENAS-B');
    await openFolder(app, page, d);
    await expect(page.getByTestId(`workspace-${basename(d)}`)).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(3);
  } finally { await app.close(); }
});

test('reiniciar mantém abas pausadas e ativar não inicia agentes dos outros projetos', async () => {
  test.setTimeout(120_000);
  const first = await launchApp();
  const b = mkdtempSync(join(tmpdir(), 'orq-paused-B-'));
  try {
    await expect(first.page.locator('.proj.is-on')).toBeVisible();
    await createShell(first.page, 'S');
    await openFolder(first.app, first.page, b);
    await expect(first.page.getByTestId(`workspace-${basename(b)}`)).toBeVisible();
    await createShell(first.page, 'S');
  } finally { await first.app.close(); }
  const second = await launchApp({ project: first.project, dataDir: first.dataDir, binDir: first.binDir, env: { ORQ_E2E_PROJECT: '' } });
  try {
    await expect(second.page.getByRole('tab')).toHaveCount(2);
    await expect(second.page.getByRole('button', { name: 'Ativar workspace' })).toBeVisible();
    expect(JSON.parse(readFileSync(join(first.dataDir, 'agentes-ativos.json'), 'utf8'))).toEqual([]);
    await second.page.getByTestId(`workspace-${basename(b)}`).click();
    await expect(second.page.getByTestId('terminal-state-S')).toContainText('ocioso', { timeout: 30_000 });
    const response = await second.page.evaluate(() => window.orquestra.invoke('workspace.list', {}));
    expect(response.ok && (response.result as { workspaces: { status: string }[] }).workspaces.map((workspace) => workspace.status)).toEqual(['paused', 'open']);
  } finally { await second.app.close(); }
});

test('alternar repetidamente mantém um canvas e registra memória com um, dois e três workspaces', async () => {
  test.setTimeout(180_000);
  const { app, page, project, dataDir } = await launchApp();
  const samples: unknown[] = [];
  const sample = async (label: string) => {
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ type: metric.type, pid: metric.pid, workingSetKB: metric.memory.workingSetSize, privateKB: metric.memory.privateBytes })));
    const browserHeap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
    const agentPids = JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'));
    samples.push({ label, electronProcesses: metrics, rendererHeapBytes: browserHeap, agentPids });
  };
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await sample('1 workspace');
    const b = mkdtempSync(join(tmpdir(), 'orq-memory-B-'));
    await openFolder(app, page, b);
    await expect(page.getByTestId(`workspace-${basename(b)}`)).toHaveAttribute('aria-selected', 'true');
    await createShell(page, 'S');
    await sample('2 workspaces');
    const c = mkdtempSync(join(tmpdir(), 'orq-memory-C-'));
    await openFolder(app, page, c);
    await expect(page.getByTestId(`workspace-${basename(c)}`)).toHaveAttribute('aria-selected', 'true');
    await createShell(page, 'S');
    await sample('3 workspaces');
    const agentPidsBefore = JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'));
    for (let index = 0; index < 12; index++) {
      const dir = [project, b, c][index % 3]!;
      await page.getByTestId(`workspace-${basename(dir)}`).click();
      await expect(page.getByTestId(`workspace-${basename(dir)}`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.xterm')).toHaveCount(1);
      await expect(page.locator('.react-flow')).toHaveCount(1);
    }
    await sample('3 workspaces após 12 trocas');
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
    expect(metrics.filter((metric) => metric.type === 'Tab')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'))).toEqual(agentPidsBefore);
    const report = { measuredAt: new Date().toISOString(), scope: 'Electron main/renderer/GPU metrics and registered agent PIDs. Electron memory totals exclude external Node host and agent working sets.', samples };
    const file = test.info().outputPath('workspace-memory.json');
    writeFileSync(file, JSON.stringify(report, null, 2));
    await test.info().attach('workspace-memory', { path: file, contentType: 'application/json' });
  } finally { await app.close(); }
});
