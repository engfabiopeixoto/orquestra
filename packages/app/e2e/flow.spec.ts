import { expect, test, type Page } from '@playwright/test';
import type { FlowSnapshot } from '@orquestra/shared/flow';
import { launchApp } from './launch';

async function snapshot(page: Page): Promise<FlowSnapshot> {
  const response = await page.evaluate(() => window.orquestra.invoke('flow.get', {})); if (!response.ok) throw new Error(response.error.message); return response.result as FlowSnapshot;
}
test('fluxo 3D real executa, usa cache, edita entrada, testa e persiste no projeto', async () => {
  test.setTimeout(150000); const first = await launchApp();
  try {
    const page = first.page; await expect(page.locator('.proj.is-on')).toBeVisible();
    await page.getByTestId('flow-library').click(); await page.getByTestId('flow-example').click();
    await expect(page.getByTestId('flow-node-Hélice 3D')).toBeAttached();
    await page.getByRole('button', { name: 'Enquadrar', exact: true }).click();
    await page.getByTestId('flow-run').click(); await expect.poll(async () => (await snapshot(page)).run?.status).toBe('success');
    const graph = (await snapshot(page)).graph;
    const input = graph.nodes.find((node) => node.kind === 'input')!; const code = graph.nodes.find((node) => node.kind === 'code')!;
    const dataEdges = page.locator('.data-flow-edge'); await expect(dataEdges).toHaveCount(2);
    await expect(page.locator(`[data-id="flow:${code.id}"] .react-flow__handle-left`)).toHaveAttribute('data-handleid', 'in:quantidade');
    await expect(page.locator(`[data-id="flow:${code.id}"] .react-flow__handle-right`)).toHaveAttribute('data-handleid', 'out:geometria');
    await page.getByRole('button', { name: 'Abrir prévia 3D', exact: true }).click();
    await expect(page.getByTestId('flow-3d').locator('canvas')).toBeVisible(); await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(page.getByTestId('flow-3d')).toHaveCount(0);
    await page.getByTestId('flow-run').click(); await expect.poll(async () => Object.values((await snapshot(page)).run!.results).every((result) => result.status === 'cached')).toBe(true);
    await page.getByTestId('flow-edit-Quantidade de pontos').click(); await page.getByTestId('flow-input-value').fill('5'); await page.getByTestId('flow-save').click();
    await expect.poll(async () => (await snapshot(page)).run?.stale).toBe(true);
    await page.getByTestId('flow-run').click(); await expect.poll(async () => (await snapshot(page)).run?.status).toBe('success');
    await page.getByTestId('flow-node-Hélice 3D').getByRole('button', { name: 'Testar', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Resultados dos testes' })).toContainText('1 aprovados'); await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.reload(); await expect(page.getByTestId('flow-node-Hélice 3D')).toBeAttached();
    expect((await snapshot(page)).graph.nodes.find((node) => node.id === input.id)?.config.value).toBe(5);
  } finally { await first.app.close(); }
  const restored = await launchApp({ project: first.project, dataDir: first.dataDir, binDir: first.binDir });
  try { await expect(restored.page.getByTestId('flow-node-Hélice 3D')).toBeAttached(); expect((await snapshot(restored.page)).graph.nodes).toHaveLength(3); } finally { await restored.app.close(); }
});

test('portas de dados conectam por arrasto e nós participam dos grupos coloridos', async () => {
  test.setTimeout(100000); const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible(); await page.getByTestId('flow-library').click(); await page.getByTestId('flow-example').click();
    await page.getByRole('button', { name: 'Enquadrar', exact: true }).click();
    const initial = await snapshot(page), source = initial.graph.nodes.find((node) => node.kind === 'input')!, code = initial.graph.nodes.find((node) => node.kind === 'code')!;
    const edge = initial.graph.connections.find((edge) => edge.from === source.id)!;
    await page.evaluate((id) => window.orquestra.invoke('flow.disconnect', { id }), edge.id); await expect(page.locator('.data-flow-edge')).toHaveCount(1);
    const output = page.locator(`[data-id="flow:${source.id}"] [data-handleid="out:quantidade"]`), input = page.locator(`[data-id="flow:${code.id}"] [data-handleid="in:quantidade"]`);
    await expect(output).toBeVisible();
    let previous = '', stable = 0;
    await expect.poll(async () => { const box = await output.boundingBox(); const key = JSON.stringify(box); stable = key === previous ? stable + 1 : 0; previous = key; return stable; }, { intervals: [100] }).toBeGreaterThanOrEqual(2);
    const start = (await output.boundingBox())!, end = (await input.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down(); await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 }); await page.mouse.up();
    await expect(page.locator('.data-flow-edge')).toHaveCount(2);
    await page.getByTestId('flow-node-Hélice 3D').locator('.data-node-header').click({ position: { x: 50, y: 15 } });
    await expect(page.getByTestId('palette-group-selection')).toBeEnabled(); await page.getByTestId('palette-group-selection').click(); await page.getByTestId('group-title').fill('Algoritmos'); await page.getByTestId('group-submit').click();
    await expect(page.getByTestId('group-header-Algoritmos')).toBeAttached();
    const before = (await snapshot(page)).graph.nodes.find((node) => node.id === code.id)!.position;
    const header = (await page.getByTestId('group-header-Algoritmos').boundingBox())!; await page.mouse.move(header.x + 60, header.y + 15); await page.mouse.down(); await page.mouse.move(header.x + 85, header.y + 45, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).graph.nodes.find((node) => node.id === code.id)!.position.y).toBeGreaterThan(before.y);
    await page.getByTestId('flow-run').click(); await expect.poll(async () => (await snapshot(page)).run?.status).toBe('success');
    await page.reload(); await expect(page.getByTestId('group-header-Algoritmos')).toBeAttached(); await expect(page.locator('.data-flow-edge')).toHaveCount(2);
  } finally { await app.close(); }
});
