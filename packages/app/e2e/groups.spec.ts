import { basename, join } from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import type { GroupLayout } from '@orquestra/shared/host-protocol';
import { createShell, launchApp, screenOf } from './launch';

async function layout(page: Page): Promise<GroupLayout> {
  const response = await page.evaluate(() => window.orquestra.invoke('group.layout', {}));
  if (!response.ok) throw new Error(response.error.message);
  return response.result as GroupLayout;
}
async function menu(page: Page, title: string) {
  await page.getByTestId(`group-header-${title}`).click({ button: 'right', position: { x: 70, y: 20 } });
  await expect(page.getByRole('menu', { name: `Grupo ${title}` })).toBeVisible();
}
async function drag(page: Page, selector: string, dx: number, dy: number) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + Math.min(80, box.width / 2), box.y + Math.min(15, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(80, box.width / 2) + dx, box.y + Math.min(15, box.height / 2) + dy, { steps: 12 });
  await page.mouse.up();
}
async function emptyGroup(page: Page, title: string, kind = 'agents') {
  await page.getByTestId('palette-new-group').click();
  await page.getByTestId('group-title').fill(title);
  await page.getByTestId('group-kind').selectOption(kind);
  await page.getByTestId('group-submit').click();
  await expect(page.getByTestId(`group-header-${title}`)).toBeVisible();
}

test('agrupa seleção, move apenas os membros, edita e salva; desagrupar preserva agentes e conexões', async () => {
  test.setTimeout(150_000);
  const { app, page, project, dataDir } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await createShell(page, 'S');
    await page.getByTestId('palette-new-note').click();
    await expect(page.getByTestId('note-nota-1')).toBeVisible();
    const termBox = (await page.getByTestId('terminal-header-S').boundingBox())!;
    const noteBox = (await page.getByTestId('note-nota-1').boundingBox())!;
    await page.getByTestId('palette-area-select').click();
    await page.mouse.move(termBox.x - 15, termBox.y - 15);
    await page.mouse.down();
    await page.mouse.move(noteBox.x + noteBox.width + 15, termBox.y + 420, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId('palette-group-selection')).toContainText('(2)');
    await page.getByTestId('palette-group-selection').click();
    await page.getByTestId('group-title').fill('Planejamento');
    await page.getByRole('button', { name: 'Cor #4cc38a' }).click();
    await page.getByTestId('group-submit').click();
    await expect(page.getByTestId('group-header-Planejamento')).toContainText('Misto');

    // Connections remain between real elements, regardless of their frame.
    const connected = await page.evaluate(() => window.orquestra.invoke('edge.connect', { a: 'S', b: 'nota-1' }));
    expect(connected.ok).toBe(true);
    await page.getByTestId('palette-new-note').click();
    await expect(page.getByTestId('note-nota-2')).toBeAttached();
    const before = await layout(page);
    await drag(page, '[data-testid="group-header-Planejamento"]', 30, 100);
    await expect.poll(async () => (await layout(page)).groups[0]!.position.y).toBeGreaterThan(before.groups[0]!.position.y);
    const moved = await layout(page);
    const dx = moved.groups[0]!.position.x - before.groups[0]!.position.x;
    const dy = moved.groups[0]!.position.y - before.groups[0]!.position.y;
    for (const name of ['S', 'nota-1']) {
      expect(moved.layout[name]!.x - before.layout[name]!.x).toBeCloseTo(dx);
      expect(moved.layout[name]!.y - before.layout[name]!.y).toBeCloseTo(dy);
    }
    expect(moved.layout['nota-2']).toEqual(before.layout['nota-2']);
    const resizeHandle = page.locator('.react-flow__node-groupFrame .react-flow__resize-control.handle.bottom.right');
    await expect(resizeHandle).toBeVisible();
    const handleBox = (await resizeHandle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 15, handleBox.y + handleBox.height / 2 + 50, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await layout(page)).groups[0]!.size.height).toBeGreaterThan(moved.groups[0]!.size.height);
    expect((await layout(page)).layout.S).toEqual(moved.layout.S);

    await menu(page, 'Planejamento');
    await page.getByRole('menuitem', { name: 'Renomear', exact: true }).click();
    await page.getByTestId('group-title').fill('Equipe azul');
    await page.getByRole('button', { name: 'Cor #7aa7ff' }).click();
    await page.getByTestId('group-submit').click();
    await expect(page.getByTestId('group-header-Equipe azul')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('group-header-Equipe azul')).toBeVisible();
    expect((await layout(page)).groups[0]).toMatchObject({ id: before.groups[0]!.id, title: 'Equipe azul', color: '#7aa7ff' });
    await page.screenshot({ path: test.info().outputPath('groups-preview.png') });

    // Frame transparency leaves the terminal fully interactive.
    await page.getByTestId('terminal-body-S').click();
    await page.keyboard.type('Write-Output GROUP-OK'); await page.keyboard.press('Enter');
    await expect.poll(() => screenOf(page, 'S')).toContain('GROUP-OK');
    const pids = JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'));
    await menu(page, 'Equipe azul');
    await page.getByTestId('group-ungroup').click();
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await expect(page.getByTestId('terminal-body-S')).toBeVisible();
    expect(JSON.parse(readFileSync(join(dataDir, 'agentes-ativos.json'), 'utf8'))).toEqual(pids);
    const snapshot = await page.evaluate((dir) => window.orquestra.invoke('project.open', { dir }), project);
    expect(snapshot.ok && (snapshot.result as { edges: unknown[] }).edges).toEqual([{ a: 'S', b: 'nota-1' }]);
  } finally { await app.close(); }
});

test('arrastar para dentro e para fora mostra destino, transfere associação e excluir o quadro mantém notas', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await emptyGroup(page, 'Origem', 'notes');
    await menu(page, 'Origem');
    await page.getByRole('menuitem', { name: 'Nova anotação neste grupo' }).click();
    await expect(page.getByTestId('note-nota-1')).toBeVisible();
    await emptyGroup(page, 'Destino', 'notes');
    const second = (await layout(page)).groups.find((group) => group.title === 'Destino')!;
    const moveResponse = await page.evaluate((id) => window.orquestra.invoke('group.move', { id, position: { x: 850, y: 120 } }), second.id);
    expect(moveResponse.ok).toBe(true);
    await page.getByRole('button', { name: 'Ajustar', exact: true }).click();
    await expect.poll(async () => (await page.getByTestId('group-Destino').boundingBox())?.x ?? 0).toBeGreaterThan(500);
    await page.getByTestId('note-nota-1').locator('.note-hd').hover();
    const target = (await page.getByTestId('group-Destino').boundingBox())!;
    const note = (await page.getByTestId('note-nota-1').boundingBox())!;
    const header = (await page.getByTestId('note-nota-1').locator('.note-hd').boundingBox())!;
    const dx = target.x + target.width / 2 - (note.x + note.width / 2);
    const dy = target.y + target.height / 2 - (note.y + note.height / 2);
    await page.mouse.move(header.x + 50, header.y + 8);
    await page.mouse.down();
    await page.mouse.move(header.x + 50 + dx, header.y + 8 + dy, { steps: 12 });
    await expect(page.getByTestId('group-Destino')).toHaveClass(/is-drop-target/);
    await page.mouse.up();
    await expect.poll(async () => (await layout(page)).groups.find((group) => group.title === 'Destino')!.members.length).toBe(1);
    expect((await layout(page)).groups.find((group) => group.title === 'Origem')!.members).toEqual([]);

    const frame = (await page.getByTestId('group-Destino').boundingBox())!;
    const now = (await page.getByTestId('note-nota-1').boundingBox())!;
    // Move the note below both frames into unused canvas space.
    await drag(page, '[data-testid="note-nota-1"] .note-hd', 0, frame.y + frame.height + 50 - now.y);
    await expect.poll(async () => (await layout(page)).groups.find((group) => group.title === 'Destino')!.members.length).toBe(0);
    await page.getByTestId('group-header-Destino').click({ position: { x: 60, y: 15 } });
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('group-Destino')).toHaveCount(0);
    await expect(page.getByTestId('note-nota-1')).toBeAttached();
  } finally { await app.close(); }
});

test('cria elementos no grupo, respeita bloqueio, gerencia membros e isola workspaces', async () => {
  test.setTimeout(150_000);
  const { app, page, project } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible();
    await emptyGroup(page, 'Referências', 'notes');
    await menu(page, 'Referências');
    await page.getByRole('menuitem', { name: 'Nova anotação neste grupo' }).click();
    await expect(page.getByTestId('note-nota-1')).toBeVisible();
    expect((await layout(page)).groups[0]!.members).toHaveLength(1);
    await menu(page, 'Referências');
    await page.getByRole('menuitemcheckbox', { name: 'Bloquear quadro' }).click();
    const fixed = await layout(page);
    await drag(page, '[data-testid="group-header-Referências"]', 80, 60);
    expect((await layout(page)).groups[0]!.position).toEqual(fixed.groups[0]!.position);
    await menu(page, 'Referências');
    await page.getByRole('menuitem', { name: 'Nova anotação neste grupo' }).click();
    await expect(page.locator('.notices')).toContainText('Desbloqueie o quadro');
    await expect(page.locator('.note-node')).toHaveCount(1);
    await menu(page, 'Referências');
    await page.getByRole('menuitemcheckbox', { name: 'Desbloquear quadro' }).click();
    await menu(page, 'Referências');
    await page.getByRole('menuitem', { name: 'Novo terminal neste grupo' }).click();
    await page.getByTestId('agent-shell').check();
    await page.getByTestId('new-terminal-name').fill('S');
    await page.getByTestId('new-terminal-submit').click();
    await expect(page.getByTestId('terminal-state-S')).toContainText('ocioso', { timeout: 30_000 });
    await expect(page.getByTestId('group-header-Referências')).toContainText('Misto');
    await menu(page, 'Referências');
    await page.getByTestId('group-manage-members').click();
    await page.getByTestId('group-member-nota-1').uncheck();
    await page.getByTestId('group-members-submit').click();
    await expect(page.getByTestId('group-header-Referências')).toContainText('Agentes');

    const other = mkdtempSync(join(tmpdir(), 'orq-groups-other-'));
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, other);
    await page.getByTestId('open-project').click();
    await expect(page.getByTestId(`workspace-${basename(other)}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await emptyGroup(page, 'Referências', 'agents');
    expect((await layout(page)).groups[0]!.members).toEqual([]);
    await page.getByTestId(`workspace-${basename(project)}`).click();
    await expect(page.getByTestId('group-header-Referências')).toContainText('1 elemento');
    expect((await layout(page)).groups[0]!.members).toHaveLength(1);
  } finally { await app.close(); }
});
