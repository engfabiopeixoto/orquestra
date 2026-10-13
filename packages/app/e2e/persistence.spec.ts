import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createShell, launchApp } from './launch';

test('fechar e reabrir devolve terminais, nota, conexão e posições', async () => {
  test.setTimeout(120_000);
  const first = await launchApp();
  const { page } = first;
  await expect(page.locator('.proj.is-on')).toBeVisible();
  await createShell(page, 'S1');
  await page.getByTestId('palette-new-note').click();
  await expect(page.getByTestId('note-nota-1')).toBeVisible();

  // Edita a nota.
  await page.getByTestId('note-view-nota-1').dblclick();
  await page.getByTestId('note-editor-nota-1').fill('# Plano salvo');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('note-view-nota-1')).toContainText('Plano salvo');

  // Conecta pelo modo Conectar.
  await page.getByTestId('palette-connect').click();
  await page.getByTestId('terminal-header-S1').click();
  await page.getByTestId('note-nota-1').click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // Move o terminal.
  const header = page.getByTestId('terminal-header-S1');
  const before = (await header.boundingBox())!;
  await header.hover();
  await page.mouse.down();
  await page.mouse.move(before.x + 200, before.y + 120, { steps: 10 });
  await page.mouse.up();
  await first.app.close();

  const saved = JSON.parse(readFileSync(join(first.project, '.orquestra', 'workspace.json'), 'utf8'));
  expect(saved.terminals.map((terminal: { name: string }) => terminal.name)).toEqual(['S1']);
  expect(saved.notes[0]).toMatchObject({ name: 'nota-1', content: '# Plano salvo' });
  expect(saved.connections).toEqual([{ a: 'S1', b: 'nota-1' }]);
  const movedTo = saved.terminals[0].position;

  // Reabre com a mesma pasta de dados: o projeto vem dos recentes, sem ORQ_E2E_PROJECT.
  const second = await launchApp({ project: first.project, dataDir: first.dataDir, binDir: first.binDir });
  await expect(second.page.getByTestId('terminal-state-S1')).toContainText('ocioso', { timeout: 30_000 });
  await expect(second.page.getByTestId('note-view-nota-1')).toContainText('Plano salvo');
  await expect(second.page.locator('.react-flow__edge')).toHaveCount(1);
  const reopened = JSON.parse(readFileSync(join(first.project, '.orquestra', 'workspace.json'), 'utf8'));
  expect(reopened.terminals[0].position).toEqual(movedTo);
  await second.app.close();
});
