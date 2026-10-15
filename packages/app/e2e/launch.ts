import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, type Page } from '@playwright/test';

/** Abre o app com pipe e pastas próprios: um Orquestra (ou o harness) aberto na máquina não interfere. */
export async function launchApp(opts: { project?: string; dataDir?: string; binDir?: string; env?: Record<string, string> } = {}) {
  const project = opts.project ?? mkdtempSync(join(tmpdir(), 'orq-e2e-proj-'));
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'orq-e2e-data-'));
  const binDir = opts.binDir ?? mkdtempSync(join(tmpdir(), 'orq-e2e-bin-'));
  const agyHooksFile = join(mkdtempSync(join(tmpdir(), 'orq-e2e-agy-hooks-')), 'hooks.json');
  const app = await electron.launch({
    args: ['.'],
    // O pacote do app não é "type": "module" (principal e preload em CJS): o Playwright transpila para CJS.
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      ORQ_E2E_PROJECT: project,
      ORQ_DATA_DIR: dataDir,
      ORQ_BIN_DIR: binDir,
      ORQ_AGY_HOOKS_FILE: agyHooksFile,
      ORQ_PIPE_PATH: `\\\\.\\pipe\\orq-e2e-${randomBytes(4).toString('hex')}`,
      ...opts.env,
    },
  });
  return { app, page: await app.firstWindow(), project, dataDir, binDir };
}

export async function createShell(page: Page, name: string) {
  await page.getByTestId('palette-new-terminal').click();
  await page.getByTestId('agent-shell').check();
  await page.getByTestId('new-terminal-name').fill(name);
  await page.getByTestId('new-terminal-submit').click();
  await expect(page.getByTestId(`terminal-state-${name}`)).toContainText('ocioso', { timeout: 30_000 });
}

export async function screenOf(page: Page, name: string): Promise<string> {
  const response = await page.evaluate((terminal) => window.orquestra.invoke('terminal.snapshot', { name: terminal }), name);
  return response.ok ? (response.result as { data: string }).data : '';
}
