import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

test('agente conectado usa CLI para navegar, preencher, clicar, ler e capturar; vínculo persiste e desconectar revoga acesso', async () => {
  test.setTimeout(150000);
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agente no navegador</title></head><body><h1>Teste do agente</h1><label for="message">Mensagem</label><input id="message"><label for="password">Senha</label><input id="password" type="password"><button id="send" onclick="document.getElementById(\'answer\').textContent=document.getElementById(\'message\').value">Aplicar</button><p id="answer"></p></body></html>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/agent`;
  const { app, page, project, binDir } = await launchApp();
  try {
    await expect(page.locator('.proj.is-on')).toBeVisible(); await createShell(page, 'S'); await page.getByTestId('palette-new-portal').click();
    const portal = page.locator('.portal-node'); await expect(portal).toBeVisible(); const id = (await portal.getAttribute('data-testid'))!.slice('portal-node-'.length);
    const header = (await portal.locator('.portal-header').boundingBox())!;
    await page.mouse.move(header.x + 60, header.y + 10); await page.mouse.down(); await page.mouse.move(header.x + 60, header.y + 360, { steps: 15 }); await page.mouse.up();
    const source = page.locator('[data-id="S"] [data-handleid="right"]'), target = page.locator(`[data-id="${id}"] [data-handleid="left"]`);
    const a = (await source.boundingBox())!, b = (await target.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 }); await page.mouse.up();
    await expect(page.getByTestId('portal-agent-status')).toContainText('1 agente conectado');
    const cli = join(binDir, 'orq.mjs'), program = join(project, 'agent-browser.cjs');
    writeFileSync(program, `const {execFileSync}=require('node:child_process');const fs=require('node:fs');const cli=${JSON.stringify(cli)};const run=(args)=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8',windowsHide:true}));const id=run(['portal','list']).portals[0].id;run(['portal','navigate',id,${JSON.stringify(url)}]);run(['portal','type',id,'#message','Mensagem do agente']);run(['portal','type',id,'#password','password-sentinel']);run(['portal','click',id,'#send']);const page=run(['portal','check',id,'--chars','4000']);if(!page.text.includes('Mensagem do agente')||page.text.includes('password-sentinel'))throw Error('Leitura invalida');const shot=run(['portal','screenshot',id]);if(fs.readFileSync(shot.path).subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('PNG invalido');console.log('BROWSER_AGENT_OK');`);
    await page.getByTestId('terminal-body-S').click(); await page.keyboard.type('node agent-browser.cjs'); await page.keyboard.press('Enter');
    await expect.poll(() => screenOf(page, 'S'), { timeout: 45000 }).toContain('BROWSER_AGENT_OK');
    const saved = await page.evaluate(() => window.orquestra.invoke('project.open', { dir: window.orquestra.testProject! })); expect(saved.ok).toBe(true);
    await page.reload(); await expect(page.getByTestId('portal-agent-status')).toContainText('1 agente conectado');
    const registry = JSON.parse(readFileSync(join(project, '.orquestra', 'workspace.json'), 'utf8')); expect(registry.portals[0].id).toBe(id); expect(registry.connections.some((edge: { a: string; b: string }) => [edge.a, edge.b].includes(id))).toBe(true);
    await page.evaluate(({ id }) => window.orquestra.invoke('edge.disconnect', { a: 'S', b: id }), { id });
    writeFileSync(join(project, 'browser-denied.cjs'), `const {execFileSync}=require('node:child_process');try{execFileSync(process.execPath,[${JSON.stringify(cli)},'portal','check',${JSON.stringify(id)}],{encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']});throw Error('Acesso indevido')}catch(e){if(!String(e.stderr).includes('não está conectado'))throw e;console.log('BROWSER_ACCESS_REVOKED')}`);
    await page.getByTestId('terminal-body-S').click(); await page.keyboard.type('node browser-denied.cjs'); await page.keyboard.press('Enter'); await expect.poll(() => screenOf(page, 'S')).toContain('BROWSER_ACCESS_REVOKED');
    await page.reload(); await expect(page.getByTestId('portal-agent-status')).toContainText('Conecte um agente');
  } finally { await app.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
