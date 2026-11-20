import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, type HostToMain, type ProjectSnapshot } from '@orquestra/shared';
import { silentLogger } from '../../core/src/log.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import { waitFor } from '../../core/test/helpers/wait.js';
import type { HostBridge } from '../src/bridge.js';
import { startWorkspaceManager } from '../src/workspace-manager.js';

const managers: HostBridge[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.close())); });

async function setup(dataDir = mkdtempSync(join(tmpdir(), 'orq-multi-')), adapters?: Record<string, ReturnType<typeof createFakeAdapter>>) {
  const sent: HostToMain[] = [];
  const ptyHost = new FakePtyHost();
  const manager = await startWorkspaceManager({ send: (message) => sent.push(message), adapters: adapters ?? { shell: createFakeAdapter(), agy: createFakeAdapter() }, cliScript: 'C:/orq/bin/orq.mjs', pipePath: `\\\\.\\pipe\\orq-multi-${randomUUID()}`, dataDir, recentFile: join(dataDir, 'recent.json'), settingsFile: join(dataDir, 'settings.json'), personasFile: join(dataDir, 'personas.json'), agentPidFile: join(dataDir, 'pids.json'), agyHooksFile: join(dataDir, 'test-agy-hooks.json'), log: silentLogger(), ptyHost, readyQuietMs: 10, outputIntervalMs: 5, modelCatalogDeps: { probeVersion: async () => null, probeClaudeCatalogMtime: () => null, discover: async (agent) => { throw new Error(`${agent} desativado nos testes de unidade`); } } });
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

  it('ativar um workspace emite workspace.activated (global, sem sequence) só depois de concluir', async () => {
    const { command, open, sent } = await setup();
    const a = await open();
    const b = await open();
    const activatedEvents = () => sent.flatMap((message) => (message.kind === 'event' && message.event.type === 'workspace.activated' ? [message.event] : []));
    const before = activatedEvents().length;
    const snapshot = await command('workspace.activate', { id: a.workspaceId });
    const events = activatedEvents().slice(before);
    expect(events).toEqual([{ type: 'workspace.activated', workspaceId: a.workspaceId }]);
    expect(snapshot.workspaceId).toBe(a.workspaceId);
    expect((await command('workspace.list')).selectedId).toBe(a.workspaceId);
    await command('workspace.activate', { id: b.workspaceId });
    expect(activatedEvents().at(-1)).toMatchObject({ workspaceId: b.workspaceId });
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

  it('reativar workspace que recebeu relatórios de terminal ainda permite terminal.model', async () => {
    const claude = { ...createFakeAdapter(), kind: 'claude' };
    const first = await setup(undefined, { shell: createFakeAdapter(), agy: createFakeAdapter(), claude });
    const a = await first.open();
    await first.command('terminal.create', { name: 'C', agent: 'claude' }, a.workspaceId);
    first.ptyHost.spawned[0]!.pty.emitData('pronto> ');
    await waitFor(() => first.sent.some((m) => m.kind === 'event' && m.event.type === 'terminal.state' && m.event.workspaceId === a.workspaceId && m.event.name === 'C' && m.event.state === 'idle'));

    await first.manager.close();
    managers.splice(managers.indexOf(first.manager), 1);

    const second = await setup(first.dataDir, { shell: createFakeAdapter(), agy: createFakeAdapter(), claude });
    await second.command('workspace.activate', { id: a.workspaceId });
    const reactivatedPty = second.ptyHost.spawned.at(-1)!.pty;
    reactivatedPty.emitData('pronto> ');
    await waitFor(() => second.sent.some((m) => m.kind === 'event' && m.event.type === 'terminal.state' && m.event.workspaceId === a.workspaceId && m.event.name === 'C' && m.event.state === 'idle'));

    // Simula xterm do renderer reidratando snapshot e respondendo consultas de terminal ao focar/anexar
    await second.command('terminal.input', { name: 'C', data: '\x1b]10;rgb:d6d6/dada/e2e2\x1b\\\x1b[>0;276;0c\x1b[?2004;2$y' }, a.workspaceId);

    const modelCmd = second.command('terminal.model', { name: 'C', model: 'sonnet' }, a.workspaceId);
    await expect(modelCmd).resolves.toMatchObject({ name: 'C', model: { chosen: 'sonnet' } });
  });

  it('usage.updated de um workspace é encaminhado globalmente sem workspaceId', async () => {
    const sent: HostToMain[] = [];
    const ptyHost = new FakePtyHost();
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-multi-'));
    const manager = await startWorkspaceManager({
      send: (message) => sent.push(message),
      adapters: { shell: createFakeAdapter(), agy: createFakeAdapter() },
      cliScript: 'C:/orq/bin/orq.mjs',
      pipePath: `\\\\.\\pipe\\orq-multi-${randomUUID()}`,
      dataDir,
      recentFile: join(dataDir, 'recent.json'),
      settingsFile: join(dataDir, 'settings.json'),
      personasFile: join(dataDir, 'personas.json'),
      agentPidFile: join(dataDir, 'pids.json'),
      agyHooksFile: join(dataDir, 'test-agy-hooks.json'),
      log: silentLogger(),
      ptyHost,
      readyQuietMs: 10,
      outputIntervalMs: 5,
      modelCatalogDeps: { probeVersion: async () => null, probeClaudeCatalogMtime: () => null, discover: async (agent) => { throw new Error(`${agent} desativado nos testes de unidade`); } },
      usageReaders: { codex: async () => ({ checkedAt: '2026-11-18T00:00:00Z', windows: [{ label: '5h', usedPercent: 15, resetsAt: null }], credits: null, details: [] }) },
    });
    managers.push(manager);
    const callMgr = async (method: string, params: unknown = {}, workspaceId?: string) => {
      const id = randomUUID();
      await manager.handle({ kind: 'command', id, method, params, workspaceId });
      return (sent.find((m) => m.kind === 'response' && m.id === id) as { kind: 'response'; result: any }).result;
    };
    const a = await callMgr('project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-project-')) });
    await callMgr('terminal.create', { name: 'R', agent: 'shell', regente: true }, a.workspaceId);
    const before = sent.length;
    const env = ptyHost.spawned[0]!.spec.env;
    await call({ pipePath: env.ORQ_PIPE!, token: env.ORQ_TOKEN! }, 'usage', { provider: 'codex' });
    const usageEvents = sent.slice(before).filter((m) => m.kind === 'event' && m.event.type === 'usage.updated');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ kind: 'event', event: { type: 'usage.updated', provider: 'codex' } });
    expect((usageEvents[0] as { event: { workspaceId?: string } }).event.workspaceId).toBeUndefined();
  });
});
