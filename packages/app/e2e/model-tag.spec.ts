import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, screenOf } from './launch';

/** PATH só com o claude falso, o Node e o Windows: o claude instalado na máquina não é aberto. */
function fakeClaudePath(): string {
  const bin = mkdtempSync(join(tmpdir(), 'orq-e2e-fake-claude-'));
  writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${join(__dirname, 'fake-model-agent.mjs')}" %*\r\n`);
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  return [bin, dirname(process.execPath), join(windows, 'System32'), windows].join(';');
}

test('a tag troca o modelo com /model sem reiniciar e o lançamento seguinte usa --model', async () => {
  test.setTimeout(120000);
  // No Windows a chave costuma ser Path: sobrescrever a mesma chave evita duas variáveis de PATH.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const { app, page } = await launchApp({ env: { [pathKey]: fakeClaudePath() } });
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('palette-new-terminal').click();
    await page.getByTestId('agent-claude').check();
    await page.getByTestId('new-terminal-name').fill('C1');
    await page.getByTestId('new-terminal-submit').click();
    await expect(page.getByTestId('terminal-state-C1')).toContainText('ocioso', { timeout: 30000 });
    const tag = page.getByTestId('terminal-model-C1');
    await expect(tag).toHaveText('modelo');
    await tag.click();
    await expect(page.getByTestId('terminal-model-menu-C1')).toBeVisible();
    await page.screenshot({ path: 'test-results/model-tag-menu.png' });
    await page.getByRole('menuitemradio', { name: 'Sonnet (mais recente)' }).click();
    await expect(tag).toHaveText('sonnet');
    await expect.poll(() => screenOf(page, 'C1')).toContain('Set model to sonnet');
    await expect(page.locator('.term-node.model-mismatch')).toHaveCount(0);
    await page.getByTestId('terminal-options-C1').click();
    await page.getByTestId('ctx-restart').click();
    await expect.poll(() => screenOf(page, 'C1'), { timeout: 30000 }).toContain('--model sonnet');
    await expect(tag).toHaveText('sonnet');
  } finally { await app.close(); }
});
