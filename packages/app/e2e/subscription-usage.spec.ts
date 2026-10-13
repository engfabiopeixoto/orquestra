import { expect, test } from '@playwright/test';
import { launchApp, screenOf } from './launch';

test('Codex habilitado e consulta de assinatura no canto superior direito', async () => {
  const { app, page } = await launchApp({ env: { PATH: `${process.env.SystemRoot}\\System32;C:\\Program Files\\nodejs`, ORQ_NODE_PATH: 'C:\\Program Files\\nodejs\\node.exe' } });
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('palette-new-terminal').click();
    await page.getByTestId('agent-codex').check();
    await expect(page.getByTestId('new-terminal-name')).toHaveValue('codex-1');
    await page.getByTestId('new-terminal-submit').click();
    await expect(page.getByTestId('terminal-state-codex-1')).toContainText(/ocioso|aguardando/, { timeout: 30000 });
    await page.getByTestId('terminal-body-codex-1').click();
    await page.keyboard.type('/mcp');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenOf(page, 'codex-1'), { timeout: 30000 }).toContain('orquestra');
    await page.keyboard.press('Escape');
    // Exercise the complete read-only host RPC using the existing local login.
    await page.getByRole('button', { name: /Uso das assinaturas/ }).click();
    await expect(page.getByRole('region', { name: 'Assinatura Codex · ChatGPT' }).getByRole('button', { name: 'Atualizar', exact: true })).toBeEnabled({ timeout: 20000 });
    await expect(page.getByText('Codex · ChatGPT')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Assinatura Claude' }).getByRole('button', { name: 'Abrir conta ↗' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Assinatura Antigravity' }).getByRole('button', { name: 'Atualizar', exact: true })).toBeEnabled({ timeout: 40000 });
    const panel = await page.locator('.subscription-usage').boundingBox();
    const canvas = await page.locator('main.canvas').boundingBox();
    expect(panel!.y - canvas!.y).toBeLessThan(20);
    expect(canvas!.x + canvas!.width - panel!.x - panel!.width).toBeLessThan(20);
    // Both successful reads and unavailable-account messages are legitimate.
    await expect(page.locator('.usage-details')).toContainText(/% usado|Uso indisponível|consulta|não retornou|não encontrado/i);
    await page.screenshot({ path: 'test-results/subscription-usage.png' });
  } finally {
    await app.close();
  }
});
