import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

test('explorador acompanha alterações salvas e resumo separa 5h de 7d', async () => {
  const project = mkdtempSync(join(tmpdir(), 'orq-explorer-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'app.ts'), 'export const app = true;\n');
  for (const name of ['adicoes.txt', 'alteracoes.txt', 'remocoes.txt', 'excluido.txt']) writeFileSync(join(project, name), 'primeira\nsegunda\n');
  const { app, page } = await launchApp({ project });
  try {
    await expect(page.getByTestId('file-adicoes.txt')).toBeVisible({ timeout: 30000 });
    writeFileSync(join(project, 'adicoes.txt'), 'primeira\nsegunda\nterceira\n');
    writeFileSync(join(project, 'alteracoes.txt'), 'primeira\natualizada\n');
    writeFileSync(join(project, 'remocoes.txt'), 'primeira\n');
    unlinkSync(join(project, 'excluido.txt'));
    await expect(page.getByTestId('file-adicoes.txt')).toHaveClass(/file-added/, { timeout: 10000 });
    await expect(page.getByTestId('file-alteracoes.txt')).toHaveClass(/file-modified/);
    await expect(page.getByTestId('file-remocoes.txt')).toHaveClass(/file-removed/);
    await expect(page.getByTestId('file-excluido.txt')).toHaveClass(/file-removed/);
    await page.getByTestId('file-src').click();
    await expect(page.getByTestId('file-src/app.ts')).toBeVisible();
    await page.getByTestId('file-alteracoes.txt').click();
    await expect(page.getByRole('dialog', { name: 'Arquivo alteracoes.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    await expect(page.locator('.code-added').filter({ hasText: '+atualizada' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar arquivo' }).click();
    const five = await page.getByTestId('usage-summary-codex-5h').boundingBox();
    const seven = await page.getByTestId('usage-summary-codex-7d').boundingBox();
    expect(seven!.y).toBeGreaterThan(five!.y);
    await page.screenshot({ path: 'test-results/file-explorer.png' });
  } finally { await app.close(); }
});
