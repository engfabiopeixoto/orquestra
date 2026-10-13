import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, defaultFlowNode, type HostToMain, type ProjectSnapshot } from '@orquestra/shared';
import { silentLogger } from '../../core/src/log.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import { waitFor } from '../../core/test/helpers/wait.js';
import type { HostBridge } from '../src/bridge.js';
import { startWorkspaceManager } from '../src/workspace-manager.js';

const managers: HostBridge[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.close())); });

async function setup(dataDir = mkdtempSync(join(tmpdir(), 'orq-multi-'))) {
  const sent: HostToMain[] = [];
  const ptyHost = new FakePtyHost();
  const manager = await startWorkspaceManager({ send: (message) => sent.push(message), adapters: { shell: createFakeAdapter(), agy: createFakeAdapter() }, cliScript: 'C:/orq/bin/orq.mjs', pipePath: `\\\\.\\pipe\\orq-multi-${randomUUID()}`, dataDir, recentFile: join(dataDir, 'recent.json'), settingsFile: join(dataDir, 'settings.json'), personasFile: join(dataDir, 'personas.json'), agentPidFile: join(dataDir, 'pids.json'), agyHooksFile: join(dataDir, 'test-agy-hooks.json'), log: silentLogger(), ptyHost, readyQuietMs: 10, outputIntervalMs: 5 });
  managers.push(manager);
  async function command(method: string, params: unknown = {}, workspaceId?: string) {
    const id = randomUUID();
    await manager.handle({ kind: 'command', id, method, params, workspaceId });
    const response = sent.find((message) => (message.kind === 'response' || message.kind === 'response-error') && message.id === id);
    if (response?.kind === 'response-error') throw Object.assign(new Error(response.error.message), { code: response.error.code });
    if (response?.kind !== 'response') throw new Error('No response');
    return response.result as any;
  }
  const open = (dir = mkdtempSync(join(tmpdir(), 'orq-project-'))) => command('project.open', { dir }) as Promise<ProjectSnapshot & { workspaceId: string }>;
  return { manager, command, open, sent, ptyHost, dataDir };
}

describe('até três workspaces isolados', () => {
  it('fluxos de workspaces diferentes compartilham workers sem misturar resultados; fechar cancela apenas o seu fluxo', async () => {
    const { command, open, dataDir, sent } = await setup(); const a = await open(), b = await open();
    const one = defaultFlowNode('code', randomUUID()), two = defaultFlowNode('code', randomUUID());
    for (const [node, workspaceId, value] of [[one, a.workspaceId, 1], [two, b.workspaceId, 2]] as const) {
      node.config.language = 'javascript'; node.inputs[0]!.defaultValue = value;
      node.config.code = 'function run(IN){const end=Date.now()+500; while(Date.now()<end){}; return {saida:IN.valor}}';
      await command('flow.save', { node }, workspaceId); await command('flow.run', { force: false }, workspaceId);
    }
    await expect(command('flow.inspect', { nodeId: one.id, port: 'saida', direction: 'output' }, b.workspaceId)).rejects.toThrow();
    await command('project.close', {}, a.workspaceId);
    let state: any;
    for (let i = 0; i < 100; i++) { state = await command('flow.get', {}, b.workspaceId); if (state.run.status !== 'running') break; await new Promise((resolve) => setTimeout(resolve, 25)); }
    expect(state.run.status).toBe('success');
    expect((await command('flow.inspect', { nodeId: two.id, port: 'saida', direction: 'output' }, b.workspaceId)).value).toBe(2);
    expect(state.graph.nodes).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, 'pids.json'), 'utf8')).length).toBeLessThanOrEqual(2);
    const events = sent.filter((message) => message.kind === 'event' && message.event.type === 'flow.node');
    expect(events.some((message) => message.kind === 'event' && message.event.workspaceId === b.workspaceId)).toBe(true);
  });
  it('grupos e IDs de membros não atravessam projetos com nomes iguais', async () => {
    const { command, open } = await setup();
    const a = await open();
    const noteA = await command('note.create', { name: 'nota', content: 'A' }, a.workspaceId);
    const created = await command('group.create', { title: 'Equipe', color: '#7aa7ff', kind: 'notes', position: { x: 0, y: 0 }, members: [{ kind: 'note', id: noteA.id }] }, a.workspaceId);
    const b = await open();
    await command('note.create', { name: 'nota', content: 'B' }, b.workspaceId);
    await expect(command('group.move', { id: created.groups[0].id, position: { x: 50, y: 50 } }, b.workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(command('group.create', { title: 'Equipe', color: '#7aa7ff', kind: 'notes', position: { x: 0, y: 0 }, members: [{ kind: 'note', id: noteA.id }] }, b.workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await command('group.layout', {}, b.workspaceId)).groups).toEqual([]);
    expect((await command('workspace.activate', { id: a.workspaceId })).groups[0].id).toBe(created.groups[0].id);
  });
  it('uma criação pendente de confirmação termina no projeto de origem após abrir outro', async () => {
    const { command, open, manager, sent, ptyHost } = await setup();
    const a = await open();
    const creating = command('terminal.create', { name: 'A', agent: 'agy' }, a.workspaceId);
    await waitFor(() => sent.some((message) => message.kind === 'confirm'));
    const b = await open();
    const confirmation = sent.find((message) => message.kind === 'confirm');
    if (confirmation?.kind !== 'confirm') throw new Error('Missing confirmation');
    await manager.handle({ kind: 'confirm-reply', id: confirmation.id, approved: true });
    expect(await creating).toMatchObject({ name: 'A', cwd: a.dir });
    expect(ptyHost.spawned[0]!.spec.cwd).toBe(a.dir);
    expect((await command('workspace.activate', { id: b.workspaceId })).terminals).toEqual([]);
  });
  it('reserva vagas em aberturas concorrentes e reutiliza caminhos canônicos', async () => {
    const { command, open } = await setup();
    const results = await Promise.allSettled([open(), open(), open(), open()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const workspace = (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<ProjectSnapshot>).value;
    const same = await open(join(workspace.dir, '.'));
    expect(same.workspaceId).toBe(workspace.workspaceId);
    expect((await command('workspace.list')).workspaces).toHaveLength(3);
  });

  it('nomes iguais não compartilham input, tela, notas ou pipes; trocar não encerra agentes', async () => {
    const { command, open, ptyHost } = await setup();
    const a = await open();
    await command('terminal.create', { name: 'codex-1', agent: 'shell' }, a.workspaceId);
    const b = await open();
    await command('terminal.create', { name: 'codex-1', agent: 'shell' }, b.workspaceId);
    ptyHost.spawned[0]!.pty.emitData('APENAS-A');
    ptyHost.spawned[1]!.pty.emitData('APENAS-B');
    await command('terminal.input', { name: 'codex-1', data: 'input-a' }, a.workspaceId);
    expect(ptyHost.spawned[0]!.pty.written).toContain('input-a');
    expect(ptyHost.spawned[1]!.pty.written).not.toContain('input-a');
    expect((await command('terminal.snapshot', { name: 'codex-1' }, a.workspaceId)).data).toContain('APENAS-A');
    expect((await command('terminal.snapshot', { name: 'codex-1' }, b.workspaceId)).data).not.toContain('APENAS-A');
    await command('note.create', { name: 'nota', content: 'A' }, a.workspaceId);
    const back = await command('workspace.activate', { id: a.workspaceId });
    expect(back.notes[0].content).toBe('A');
    expect(ptyHost.spawned).toHaveLength(2);
    const firstEnv = ptyHost.spawned[0]!.spec.env;
    const secondEnv = ptyHost.spawned[1]!.spec.env;
    expect(firstEnv.ORQ_PIPE).not.toBe(secondEnv.ORQ_PIPE);
    await expect(call({ pipePath: secondEnv.ORQ_PIPE!, token: firstEnv.ORQ_TOKEN! }, 'whoami', {})).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    const who = await call({ pipePath: firstEnv.ORQ_PIPE!, token: firstEnv.ORQ_TOKEN! }, 'whoami', {});
    expect(who).toMatchObject({ name: 'codex-1' });
  });

  it('saída em segundo plano é retida no snapshot e não enviada ao renderer', async () => {
    const { command, open, ptyHost, sent } = await setup();
    const a = await open();
    await command('terminal.create', { name: 'A', agent: 'shell' }, a.workspaceId);
    const b = await open();
    const start = sent.length;
    ptyHost.spawned[0]!.pty.emitData('trabalhando no fundo');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.slice(start).some((message) => message.kind === 'event' && message.event.type === 'terminal.output')).toBe(false);
    await command('workspace.activate', { id: a.workspaceId });
    expect((await command('terminal.snapshot', { name: 'A' }, a.workspaceId)).data).toContain('trabalhando no fundo');
    expect((await command('workspace.list')).selectedId).not.toBe(b.workspaceId);
  });

  it('fechar um projeto salva seu canvas, invalida acesso e libera uma vaga sem parar os outros', async () => {
    const { command, open, ptyHost } = await setup();
    const projects = [await open(), await open(), await open()];
    for (const project of projects) await command('terminal.create', { name: 'A', agent: 'shell' }, project.workspaceId);
    await command('layout.update', { nodes: [{ name: 'A', x: 400, y: 80, width: 640, height: 400 }] }, projects[0]!.workspaceId);
    await command('project.close', {}, projects[0]!.workspaceId);
    expect(JSON.parse(readFileSync(join(projects[0]!.dir, '.orquestra/workspace.json'), 'utf8')).terminals[0].position.x).toBe(400);
    await expect(command('terminal.input', { name: 'A', data: 'errado' }, projects[0]!.workspaceId)).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
    await command('terminal.input', { name: 'A', data: 'continua' }, projects[1]!.workspaceId);
    expect(ptyHost.spawned[1]!.pty.written).toContain('continua');
    await open();
    expect((await command('workspace.list')).workspaces).toHaveLength(3);
  });

  it('reiniciar restaura somente abas pausadas; ativar inicia apenas o projeto escolhido', async () => {
    const first = await setup();
    const a = await first.open();
    await first.command('terminal.create', { name: 'A', agent: 'shell' }, a.workspaceId);
    const b = await first.open();
    await first.command('terminal.create', { name: 'B', agent: 'shell' }, b.workspaceId);
    await first.manager.close(); managers.splice(managers.indexOf(first.manager), 1);
    const second = await setup(first.dataDir);
    expect((await second.command('workspace.list')).workspaces.map((entry: { status: string }) => entry.status)).toEqual(['paused', 'paused']);
    expect(second.ptyHost.spawned).toHaveLength(0);
    await second.command('workspace.activate', { id: a.workspaceId });
    expect(second.ptyHost.spawned).toHaveLength(1);
    expect((await second.command('workspace.list')).workspaces[1].status).toBe('paused');
  });

  it('falha de abertura não consome vaga nem prejudica um projeto aberto', async () => {
    const { command, open } = await setup();
    const a = await open();
    await expect(open(join(a.dir, 'ausente'))).rejects.toMatchObject({ code: 'USAGE' });
    expect((await command('workspace.list')).workspaces).toHaveLength(1);
    await command('note.create', { name: 'ok', content: 'continua' }, a.workspaceId);
  });

  it('regentes e comandos de agente mantêm o contexto do projeto original', async () => {
    const { command, open, ptyHost } = await setup();
    const a = await open();
    await command('terminal.create', { name: 'R', agent: 'shell', regente: true }, a.workspaceId);
    await open();
    const env = ptyHost.spawned[0]!.spec.env;
    await call({ pipePath: env.ORQ_PIPE!, token: env.ORQ_TOKEN! }, 'note.write', { name: 'do-regente', content: 'origem' });
    const back = await command('workspace.activate', { id: a.workspaceId });
    expect(back.notes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'do-regente', content: 'origem' })]));
  });

  it('registro inválido é ignorado sem iniciar processos', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-registry-'));
    writeFileSync(join(dataDir, 'workspaces.json'), '{broken');
    const { command, ptyHost } = await setup(dataDir);
    expect((await command('workspace.list')).workspaces).toEqual([]);
    expect(ptyHost.spawned).toEqual([]);
  });
});
