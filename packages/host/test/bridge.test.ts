import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, defaultFlowNode, type HostToMain } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../core/src/adapters/types.js';
import { silentLogger } from '../../core/src/log.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';
import { waitFor } from '../../core/test/helpers/wait.js';
import { startHostBridge, type HostBridge } from '../src/bridge.js';

let bridge: HostBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

const readWorkspace = (dir: string) => JSON.parse(readFileSync(join(dir, '.orquestra', 'workspace.json'), 'utf8'));

type SetupOptions = { outputIntervalMs?: number; saveDelayMs?: number; adapters?: Record<string, AgentAdapter> };

async function setup(opts: SetupOptions = {}) {
  const sent: HostToMain[] = [];
  const agentPidFile = join(mkdtempSync(join(tmpdir(), 'orq-pids-')), 'agentes-ativos.json');
  const recentFile = join(mkdtempSync(join(tmpdir(), 'orq-recent-')), 'recent.json');
  const settingsFile = join(mkdtempSync(join(tmpdir(), 'orq-settings-')), 'settings.json');
  const personasFile = join(mkdtempSync(join(tmpdir(), 'orq-personas-')), 'personas.json');
  const ptyHost = new FakePtyHost();
  const outputIntervalMs = opts.outputIntervalMs ?? 5;
  bridge = await startHostBridge({
    send: (message: HostToMain) => sent.push(message),
    adapters: opts.adapters ?? { shell: createFakeAdapter(), agy: createFakeAdapter() },
    recentFile,
    settingsFile,
    personasFile,
    saveDelayMs: opts.saveDelayMs ?? 20,
    cliScript: 'C:/orq/bin/orq.mjs',
    pipePath: `\\\\.\\pipe\\orq-bridge-${randomBytes(4).toString('hex')}`,
    dataDir: mkdtempSync(join(tmpdir(), 'orq-bridge-')),
    log: silentLogger(),
    ptyHost,
    readyQuietMs: 20,
    agyHooksFile: join(mkdtempSync(join(tmpdir(), 'orq-agyhook-')), 'hooks.json'),
    outputIntervalMs,
    agentPidFile,
  } as any);
  const command = async (id: string, method: string, params: unknown) => {
    await bridge!.handle({ kind: 'command', id, method, params });
    return sent.find((message) => (message.kind === 'response' || message.kind === 'response-error') && message.id === id);
  };
  return { sent, ptyHost, command, agentPidFile, recentFile, settingsFile, personasFile };
}

describe('ponte do núcleo', () => {
  it('navegador exige conexão, encaminha operações e persiste vínculos; remover invalida acesso', async () => {
    const { command, sent } = await setup(); let sequence = 0;
    const request = async (method: string, params: unknown) => { const result = await command(`browser-${sequence++}`, method, params); if (result?.kind !== 'response') throw new Error(JSON.stringify(result)); return result.result as any; };
    const dir = mkdtempSync(join(tmpdir(), 'orq-browser-links-')); await request('project.open', { dir });
    await request('terminal.create', { name: 'A', agent: 'shell' }); await request('portal.register', { id: 'portal-test', title: 'Site' });
    expect(await bridge!.dispatchForTest('portal.list', {}, { session: 'A' })).toEqual({ portals: [] });
    await expect(bridge!.dispatchForTest('portal.check', { id: 'portal-test' }, { session: 'A' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await request('edge.connect', { a: 'A', b: 'portal-test' });
    expect(await bridge!.dispatchForTest('portal.list', {}, { session: 'A' })).toEqual({ portals: [{ id: 'portal-test', title: 'Site' }] });
    const reading = bridge!.dispatchForTest('portal.check', { id: 'portal-test' }, { session: 'A' });
    await waitFor(() => sent.some((message) => message.kind === 'portal-call'));
    const rpc = sent.find((message) => message.kind === 'portal-call')!; if (rpc.kind !== 'portal-call') throw new Error('Missing RPC');
    await bridge!.handle({ kind: 'portal-reply', id: rpc.id, ok: true, result: { id: 'portal-test', url: 'http://localhost/', title: 'Site', text: 'Página', mode: 'desktop', presetId: 'desktop-compact', elements: [] } });
    expect(await reading).toMatchObject({ text: 'Página' });
    await request('project.close', {}); expect(readWorkspace(dir).connections).toContainEqual({ a: 'A', b: 'portal-test' });
    await request('project.open', { dir }); expect(await bridge!.dispatchForTest('portal.list', {}, { session: 'A' })).toMatchObject({ portals: [{ id: 'portal-test' }] });
    await request('portal.unregister', { id: 'portal-test' });
    await expect(bridge!.dispatchForTest('portal.click', { id: 'portal-test', selector: 'button' }, { session: 'A' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('nós de fluxo participam dos grupos e persistem com seus contratos e conexões', async () => {
    const { command } = await setup();
    let sequence = 0;
    const result = async (method: string, params: unknown) => { const response = await command(`flow-${sequence++}`, method, params); if (response?.kind !== 'response') throw new Error(JSON.stringify(response)); return response.result as any; };
    const dir = mkdtempSync(join(tmpdir(), 'orq-flow-group-')); await result('project.open', { dir });
    const node = defaultFlowNode('input', randomUUID(), { x: 100, y: 100 });
    await result('flow.save', { node });
    const created = await result('group.create', { title: 'Dados', color: '#7aa7ff', kind: 'mixed', position: { x: 0, y: 0 }, members: [{ kind: 'flow', id: node.id }] });
    const group = created.groups[0];
    const moved = await result('group.move', { id: group.id, position: { x: group.position.x + 40, y: group.position.y + 70 } });
    expect(moved.layout[`flow:${node.id}`]).toMatchObject({ x: 140, y: 170 });
    await result('group.update', { id: group.id, locked: true });
    expect(await command('flow-failed', 'flow.move', { nodes: [{ id: node.id, position: { x: 9999, y: 9999 } }] })).toMatchObject({ kind: 'response-error' });
    expect((await result('flow.get', {})).graph.nodes[0].position).toEqual({ x: 140, y: 170 });
    await result('project.close', {});
    const saved = readWorkspace(dir); expect(saved.flow.nodes[0].id).toBe(node.id); expect(saved.groups[0].members).toEqual([{ kind: 'flow', id: node.id }]);
    await result('project.open', { dir }); expect((await result('flow.get', {})).graph.nodes[0].position).toEqual({ x: 140, y: 170 });
  });
  it('grupos persistem por ID, movem membros e mantêm os agentes e conexões ao desagrupar', async () => {
    const { command, ptyHost } = await setup({ adapters: { shell: { ...createFakeAdapter(), kind: 'shell' } } });
    const result = async (id: string, method: string, params: unknown) => {
      const response = await command(id, method, params);
      if (response?.kind !== 'response') throw new Error(JSON.stringify(response));
      return response.result as any;
    };
    const dir = mkdtempSync(join(tmpdir(), 'orq-group-persist-'));
    await result('g-open', 'project.open', { dir });
    const terminal = await result('g-term', 'terminal.create', { name: 'A', agent: 'shell' });
    const note = await result('g-note', 'note.create', { name: 'nota', content: 'Plano' });
    await result('g-connect', 'edge.connect', { a: 'A', b: 'nota' });
    await result('g-place', 'layout.update', { nodes: [{ name: 'A', x: 100, y: 100, width: 640, height: 400 }, { name: 'nota', x: 800, y: 100, width: 320, height: 240 }] });
    const created = await result('g-create', 'group.create', { title: 'Equipe', color: '#4cc38a', kind: 'mixed', position: { x: 0, y: 0 }, members: [{ kind: 'terminal', id: terminal.id }, { kind: 'note', id: note.id }] });
    const group = created.groups[0];
    const moved = await result('g-move', 'group.move', { id: group.id, position: { x: group.position.x + 50, y: group.position.y + 100 } });
    expect(moved.layout.A).toMatchObject({ x: 150, y: 200 });
    expect(moved.layout.nota).toMatchObject({ x: 850, y: 200 });
    await result('g-rename', 'terminal.rename', { name: 'A', newName: 'B' });
    const restarted = await result('g-restart', 'terminal.restart', { name: 'B' });
    expect(restarted.id).toBe(terminal.id);
    await result('g-close', 'project.close', {});
    const reopened = await result('g-reopen', 'project.open', { dir });
    expect(reopened.groups[0]).toMatchObject({ id: group.id, members: [{ kind: 'terminal', id: terminal.id }, { kind: 'note', id: note.id }] });
    expect(reopened.layout.B).toMatchObject({ x: 150, y: 200 });
    const spawned = ptyHost.spawned.length;
    await result('g-remove', 'group.remove', { id: group.id });
    const snapshot = await result('g-final', 'project.open', { dir });
    expect(snapshot.terminals.map((terminal: { name: string }) => terminal.name)).toEqual(['B']);
    expect(snapshot.edges).toEqual([{ a: 'B', b: 'nota' }]);
    expect(ptyHost.spawned).toHaveLength(spawned);
  });

  it('falha de layout com quadro bloqueado desfaz posições e associações; criar fora do quadro não deixa agente órfão', async () => {
    const { command, ptyHost } = await setup({ adapters: { shell: { ...createFakeAdapter(), kind: 'shell' } } });
    const result = async (id: string, method: string, params: unknown) => {
      const response = await command(id, method, params);
      if (response?.kind !== 'response') throw new Error(JSON.stringify(response));
      return response.result as any;
    };
    await result('l-open', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-group-lock-')) });
    const created = await result('l-create', 'group.create', { title: 'Notas', color: '#7aa7ff', kind: 'notes', position: { x: 0, y: 0 }, members: [] });
    const group = created.groups[0];
    const note = await result('l-note', 'note.create', { name: 'nota', content: '', groupId: group.id });
    await result('l-lock', 'group.update', { id: group.id, locked: true });
    const before = await result('l-before', 'group.layout', {});
    expect(await command('l-out', 'layout.update', { nodes: [{ name: 'nota', x: 9000, y: 9000, width: 320, height: 240 }] })).toMatchObject({ kind: 'response-error', error: { code: 'USAGE' } });
    expect(await result('l-after', 'group.layout', {})).toEqual(before);
    const spawned = ptyHost.spawned.length;
    expect(await command('l-no-spawn', 'terminal.create', { name: 'A', agent: 'shell', groupId: group.id })).toMatchObject({ kind: 'response-error', error: { code: 'USAGE' } });
    expect(ptyHost.spawned).toHaveLength(spawned);
    await result('l-remove', 'note.remove', { name: note.name });
    expect((await result('l-empty', 'group.layout', {})).groups[0].members).toEqual([]);
  });
  it('salva desfoco, bloqueio e descarregamento; duplica com uma sessão independente', async () => {
    const { command, ptyHost, agentPidFile } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'orq-menu-'));
    await command('menu-open', 'project.open', { dir });
    await command('menu-create', 'terminal.create', { name: 'A', agent: 'shell', args: ['--test'] });
    await command('menu-layout', 'layout.update', { nodes: [{ name: 'A', x: 20, y: 30, width: 640, height: 400 }] });
    await command('menu-look', 'terminal.presentation', { name: 'A', blurred: true, locked: true });
    await command('menu-blocked-layout', 'layout.update', { nodes: [{ name: 'A', x: 999, y: 999, width: 320, height: 180 }] });
    const duplicated = await command('menu-copy', 'terminal.duplicate', { name: 'A' });
    expect(duplicated).toMatchObject({ kind: 'response', result: { info: { name: 'A-copia', args: ['--test'] }, rect: { width: 640, height: 400 } } });
    expect(ptyHost.spawned[0]?.spec.env.ORQ_TOKEN).not.toBe(ptyHost.spawned[1]?.spec.env.ORQ_TOKEN);
    await command('menu-stop', 'terminal.unload', { name: 'A' });
    expect(await command('menu-input', 'terminal.input', { name: 'A', data: 'abc' })).toMatchObject({ kind: 'response-error', error: { code: 'APP_UNAVAILABLE' } });
    await command('menu-close', 'project.close', {});
    expect(readWorkspace(dir).terminals.find((terminal: { name: string }) => terminal.name === 'A')).toMatchObject({ unloaded: true, blurred: true, locked: true, position: { x: 20, y: 30 } });
    const count = ptyHost.spawned.length;
    const restored = await command('menu-reopen', 'project.open', { dir });
    expect(restored).toMatchObject({ kind: 'response', result: { terminals: expect.arrayContaining([expect.objectContaining({ name: 'A', unloaded: true, blurred: true, locked: true })]) } });
    expect(ptyHost.spawned.length - count).toBe(1); // Only the independent copy is started.
    expect(JSON.parse(readFileSync(agentPidFile, 'utf8'))).not.toContain(0);
  });
  it('criar terminal sem projeto aberto é erro de uso', async () => {
    const { command } = await setup();
    expect(await command('1', 'terminal.create', { name: 'A', agent: 'shell' })).toMatchObject({
      kind: 'response-error',
      error: { code: 'USAGE', message: expect.stringMatching(/Nenhum projeto aberto/) },
    });
  });

  it('abre o projeto, cria o terminal na pasta dele e repassa saída agrupada', async () => {
    const { command, sent, ptyHost } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    expect(await command('1', 'project.open', { dir })).toMatchObject({ kind: 'response', result: { dir } });
    expect(await command('2', 'terminal.create', { name: 'A', agent: 'shell' })).toMatchObject({
      kind: 'response',
      result: { name: 'A', agent: 'fake', cwd: dir },
    });
    ptyHost.last().emitData('olá');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'terminal.output', name: 'A', data: 'olá' } });
  });

  it('saída recebida antes do retrato vai antes da resposta e não se repete depois', async () => {
    // Intervalo longo: a saída ainda está no agrupador quando o retrato é pedido.
    const { command, sent, ptyHost } = await setup({ outputIntervalMs: 1000 });
    await command('1', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-proj-')) });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    ptyHost.last().emitData('linha X');
    const response = await command('3', 'terminal.snapshot', { name: 'A' });
    expect(response).toMatchObject({ kind: 'response', result: { data: expect.stringContaining('linha X') } });
    const outputIndex = sent.findIndex((message) => message.kind === 'event' && message.event.type === 'terminal.output');
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeLessThan(sent.indexOf(response!));
  });

  it('reabrir a mesma pasta (interface recarregada) mantém os terminais e devolve terminais e conexões', async () => {
    const { command, ptyHost } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    await command('3', 'terminal.create', { name: 'B', agent: 'shell' });
    await command('4', 'edge.connect', { a: 'B', b: 'A' });
    const spawned = ptyHost.spawned.length;
    expect(await command('5', 'project.open', { dir })).toMatchObject({
      kind: 'response',
      result: { dir, terminals: [{ name: 'A' }, { name: 'B' }], edges: [{ a: 'A', b: 'B' }] },
    });
    expect(ptyHost.spawned.length).toBe(spawned);
    expect(await command('6', 'terminal.snapshot', { name: 'A' })).toMatchObject({ kind: 'response' });
  });

  it('mantém num arquivo os PIDs dos agentes vivos, para o principal limpar se o núcleo cair', async () => {
    const { command, agentPidFile } = await setup();
    const pids = () => JSON.parse(readFileSync(agentPidFile, 'utf8')) as number[];
    await command('1', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-proj-')) });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    expect(pids()).toEqual([1]);
    await command('3', 'terminal.remove', { name: 'A' });
    expect(pids()).toEqual([]);
  });

  it('id novo da sessão do agente não remove o terminal, e retomada que falha vira terminal.notice', async () => {
    // O Stop traz o id da sessão do agente, como o conversationId do agy.
    const adapter: AgentAdapter = {
      ...createFakeAdapter(),
      interpretHook: () => ({ kind: 'turn-end', text: null, transcriptPath: null, agentSessionId: 'conv-1' }),
    };
    const { command, sent, ptyHost } = await setup({ adapters: { shell: adapter, agy: createFakeAdapter() } });
    const removed = () => sent.filter((message) => message.kind === 'event' && message.event.type === 'terminal.removed');
    await command('1', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-proj-')) });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    const env = ptyHost.spawned.at(-1)!.spec.env;
    await call({ pipePath: env.ORQ_PIPE!, token: env.ORQ_TOKEN! }, 'hook', { agent: 'fake', event: 'Stop', payload: {} });
    expect(removed()).toEqual([]);
    // O reinício retoma a sessão; o agente sai logo e o núcleo relança sem retomar, com aviso.
    await command('3', 'terminal.restart', { name: 'A' });
    expect(ptyHost.spawned.at(-1)!.spec.args).toContain('--resume');
    ptyHost.last().emitExit(1);
    const notice = { kind: 'event', event: { type: 'terminal.notice', name: 'A', message: expect.stringMatching(/a sessão anterior não pôde ser retomada/) } };
    await waitFor(() => sent.some((message) => message.kind === 'event' && message.event.type === 'terminal.notice'));
    expect(sent).toContainEqual(notice);
    expect(removed()).toEqual([]);
  });

  it('agy pede confirmação do hook e, recusada, não cria o terminal', async () => {
    const { command, sent } = await setup();
    await command('1', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-proj-')) });
    const pending = command('2', 'terminal.create', { name: 'B', agent: 'agy' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const confirm = sent.find((message) => message.kind === 'confirm');
    expect(confirm).toBeDefined();
    await bridge!.handle({ kind: 'confirm-reply', id: confirm!.kind === 'confirm' ? confirm!.id : '', approved: false });
    expect(await pending).toMatchObject({ kind: 'response-error', error: { code: 'USAGE', message: expect.stringMatching(/hook global/) } });
  });

  it('método desconhecido e parâmetros inválidos voltam como erro de uso', async () => {
    const { command } = await setup();
    expect(await command('1', 'terminal.kill', {})).toMatchObject({ kind: 'response-error', error: { code: 'USAGE' } });
    expect(await command('2', 'terminal.resize', { name: 'A', cols: 0, rows: 1 })).toMatchObject({ kind: 'response-error', error: { code: 'USAGE' } });
  });
});

describe('workspace na ponte', () => {
  // O adaptador falso tem kind 'fake', que não é agente do workspace e ficaria fora da gravação.
  const shellAdapter = (): AgentAdapter => ({ ...createFakeAdapter(), kind: 'shell' });

  it('grava terminais, notas, conexões, layout e viewport, e reabre tudo', async () => {
    const first = await setup({ adapters: { shell: shellAdapter() } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await first.command('1', 'project.open', { dir });
    await first.command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    await first.command('3', 'note.create', { name: 'plano', content: '# x' });
    await first.command('4', 'edge.connect', { a: 'A', b: 'plano' });
    await first.command('5', 'layout.update', {
      nodes: [{ name: 'A', x: 10, y: 20, width: 500, height: 300 }, { name: 'plano', x: 600, y: 20, width: 320, height: 240 }],
      viewport: { x: 5, y: 6, zoom: 0.75 },
    });
    await bridge!.close();
    bridge = undefined;
    expect(readWorkspace(dir)).toMatchObject({
      viewport: { x: 5, y: 6, zoom: 0.75 },
      terminals: [{ name: 'A', agent: 'shell', position: { x: 10, y: 20 }, size: { width: 500, height: 300 } }],
      notes: [{ name: 'plano', content: '# x', revision: 1, updatedBy: 'você' }],
      connections: [{ a: 'A', b: 'plano' }],
    });

    const second = await setup({ adapters: { shell: shellAdapter() } });
    const reopened = await second.command('1', 'project.open', { dir });
    expect(reopened).toMatchObject({
      kind: 'response',
      result: {
        terminals: [{ name: 'A', agent: 'shell' }],
        notes: [{ name: 'plano', content: '# x' }],
        edges: [{ a: 'A', b: 'plano' }],
        layout: { A: { x: 10, y: 20, width: 500, height: 300 } },
        viewport: { x: 5, y: 6, zoom: 0.75 },
      },
    });
  });

  it('fechar grava na hora o que estava esperando a gravação adiada', async () => {
    const { command } = await setup({ adapters: { shell: shellAdapter() }, saveDelayMs: 60_000 });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    await bridge!.close();
    bridge = undefined;
    expect(readWorkspace(dir).terminals).toHaveLength(1);
  });

  it('abrir outro projeto grava o atual antes de encerrar os terminais', async () => {
    const { command } = await setup({ adapters: { shell: shellAdapter() }, saveDelayMs: 60_000 });
    const first = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    const second = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir: first });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    expect(await command('3', 'project.open', { dir: second })).toMatchObject({ result: { terminals: [] } });
    expect(readWorkspace(first).terminals.map((terminal: { name: string }) => terminal.name)).toEqual(['A']);
  });

  it('encerrar os terminais ao fechar ou trocar de projeto não regrava o workspace vazio depois', async () => {
    const { command } = await setup({ adapters: { shell: shellAdapter() }, saveDelayMs: 10 });
    const first = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    const second = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir: first });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    await command('3', 'project.open', { dir: second });
    await command('4', 'terminal.create', { name: 'B', agent: 'shell' });
    await bridge!.close();
    bridge = undefined;
    // Passa do prazo da gravação adiada: uma gravação agendada pela remoção dos terminais apareceria aqui.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readWorkspace(first).terminals).toHaveLength(1);
    expect(readWorkspace(second).terminals).toHaveLength(1);
  });

  it('workspace inválido abre vazio e avisa com o caminho do backup', async () => {
    const { command, sent } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    mkdirSync(join(dir, '.orquestra'));
    writeFileSync(join(dir, '.orquestra', 'workspace.json'), '{ quebrado');
    expect(await command('1', 'project.open', { dir })).toMatchObject({ result: { terminals: [], notes: [] } });
    expect(sent).toContainEqual({
      kind: 'event',
      event: { type: 'notice', level: 'warn', message: expect.stringMatching(/estava inválido e foi guardado em .*workspace\.json\.invalido-/) },
    });
  });

  it('terminal que não pode ser relançado vira aviso e os outros abrem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    mkdirSync(join(dir, '.orquestra'));
    const terminal = (name: string, cwd: string) => ({
      id: crypto.randomUUID(), name, agent: 'shell', cwd, args: [], resume: false, agentSessionId: null,
      position: { x: 0, y: 0 }, size: { width: 640, height: 400 },
    });
    writeFileSync(
      join(dir, '.orquestra', 'workspace.json'),
      JSON.stringify({ schemaVersion: 1, viewport: { x: 0, y: 0, zoom: 1 }, terminals: [terminal('A', dir), terminal('B', join(dir, 'apagada'))], notes: [], connections: [] }),
    );
    const { command, sent } = await setup({ adapters: { shell: shellAdapter() } });
    expect(await command('1', 'project.open', { dir })).toMatchObject({ result: { terminals: [{ name: 'A' }] } });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'notice', level: 'warn', message: expect.stringMatching(/Não foi possível reabrir o terminal B/) } });
  });

  it('nota criada por agente chega com posição ao lado do autor e conectada', async () => {
    const { command, sent } = await setup({ adapters: { shell: shellAdapter() } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    await command('3', 'layout.update', { nodes: [{ name: 'A', x: 100, y: 100, width: 640, height: 400 }] });
    await bridge!.dispatchForTest('note.write', { name: 'plano', content: '# x' }, { session: 'A' });
    expect(sent).toContainEqual({
      kind: 'event',
      event: { type: 'note.changed', note: expect.objectContaining({ name: 'plano', updatedBy: 'A' }), connectedTo: 'A', rect: { x: 780, y: 100, width: 320, height: 240 } },
    });
  });

  it('salvar nota com revisão antiga devolve CONFLICT; note.remove apaga', async () => {
    const { command } = await setup();
    await command('1', 'project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-proj-')) });
    await command('2', 'note.create', { name: 'plano' });
    await command('3', 'note.save', { name: 'plano', content: 'a', baseRevision: 1 });
    expect(await command('4', 'note.save', { name: 'plano', content: 'b', baseRevision: 1 })).toMatchObject({
      kind: 'response-error',
      error: { code: 'CONFLICT', message: expect.stringMatching(/alterada por você/) },
    });
    expect(await command('5', 'note.remove', { name: 'plano' })).toMatchObject({ kind: 'response' });
    expect(await command('6', 'note.save', { name: 'plano', content: 'c', baseRevision: null })).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('recent.list devolve os projetos abertos, o último primeiro', async () => {
    const { command } = await setup();
    const a = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    const b = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir: a });
    await command('2', 'project.open', { dir: b });
    expect(await command('3', 'recent.list', {})).toMatchObject({ result: { projects: [{ dir: b }, { dir: a }] } });
  });
});

describe('editar terminal e padrões na ponte', () => {
  const shellAdapter = () => ({ ...createFakeAdapter(), kind: 'shell' });

  it('cria com argumentos, edita e grava os argumentos novos no workspace', async () => {
    const { command, ptyHost } = await setup({ adapters: { shell: shellAdapter() } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    expect(await command('2', 'terminal.create', { name: 'A', agent: 'shell', args: ['-x'] })).toMatchObject({ result: { name: 'A', args: ['-x'] } });
    expect(ptyHost.last()).toBeDefined();
    expect(await command('3', 'terminal.update', { name: 'A', newName: 'B', args: ['-y'] })).toMatchObject({ result: { name: 'B', args: ['-y'] } });
    expect(ptyHost.spawned.at(-1)!.spec.args.at(-1)).toBe('-y');
    await bridge!.close();
    bridge = undefined;
    expect(readWorkspace(dir).terminals).toEqual([expect.objectContaining({ name: 'B', args: ['-y'] })]);
  });

  it('settings.get e settings.update funcionam sem projeto aberto e recusam reservados', async () => {
    const { command } = await setup();
    expect(await command('1', 'settings.get', {})).toMatchObject({ result: { defaultArgs: { claude: [], agy: [] } } });
    const settings = { defaultArgs: { claude: ['--dangerously-skip-permissions'], agy: [] } };
    expect(await command('2', 'settings.update', settings)).toMatchObject({ result: settings });
    expect(await command('3', 'settings.get', {})).toMatchObject({ result: settings });
    expect(await command('4', 'settings.update', { defaultArgs: { claude: ['-r'], agy: [] } })).toMatchObject({
      kind: 'response-error',
      error: { code: 'USAGE', message: expect.stringMatching(/-r é controlado/) },
    });
  });
});

describe('regente na ponte', () => {
  const shellAdapter = () => ({ ...createFakeAdapter(), kind: 'shell', acceptsPrompts: false });
  const agentAdapter = () => ({ ...createFakeAdapter(), kind: 'claude' });

  async function withRegent() {
    const ctx = await setup({ adapters: { shell: shellAdapter(), claude: agentAdapter() } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await ctx.command('1', 'project.open', { dir });
    await ctx.command('2', 'terminal.create', { name: 'R', agent: 'claude', regente: true });
    await ctx.command('3', 'layout.update', { nodes: [{ name: 'R', x: 100, y: 100, width: 640, height: 400 }] });
    return { ...ctx, dir };
  }

  it('regent.new cria ao lado do regente, conecta, avisa e emite terminal.added', async () => {
    const { sent } = await withRegent();
    await expect(bridge!.dispatchForTest('regent.new', { name: 'S', agent: 'shell' }, { session: 'R' })).resolves.toEqual({ name: 'S' });
    expect(sent).toContainEqual({
      kind: 'event',
      event: { type: 'terminal.added', info: expect.objectContaining({ name: 'S', regente: false }), rect: { x: 780, y: 100, width: 640, height: 400 }, connectedTo: 'R' },
    });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'notice', level: 'info', message: 'R criou S.' } });
  });

  it('regent.new com função entrega o texto pela fila do novo terminal', async () => {
    const { ptyHost } = await withRegent();
    await bridge!.dispatchForTest('persona.write', { name: 'revisor', text: 'Revise.', global: false }, { session: 'R' });
    await bridge!.dispatchForTest('regent.new', { name: 'C', agent: 'claude', persona: 'revisor' }, { session: 'R' });
    // O fake agent fica pronto e o broker digita a entrega: o texto chega ao PTY do novo terminal.
    ptyHost.last().emitData('pronto> ');
    await waitFor(() => ptyHost.spawned.at(-1)!.pty.written.join('').includes('[orq] Sua função: revisor'));
  });

  it('regente não remove a si mesmo; remover outro avisa e emite terminal.removed', async () => {
    const { sent, command } = await withRegent();
    await command('4', 'terminal.create', { name: 'S', agent: 'shell' });
    await expect(bridge!.dispatchForTest('regent.remove', { name: 'R' }, { session: 'R' })).rejects.toThrow(/não pode remover a si mesmo/);
    await bridge!.dispatchForTest('regent.remove', { name: 'S' }, { session: 'R' });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'terminal.removed', name: 'S' } });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'notice', level: 'info', message: 'R removeu S.' } });
  });

  it('link e unlink emitem os eventos de conexão', async () => {
    const { sent, command } = await withRegent();
    await command('4', 'terminal.create', { name: 'S', agent: 'shell' });
    await bridge!.dispatchForTest('regent.link', { a: 'R', b: 'S' }, { session: 'R' });
    await bridge!.dispatchForTest('regent.unlink', { a: 'R', b: 'S' }, { session: 'R' });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'edge.added', a: 'R', b: 'S' } });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'edge.removed', a: 'R', b: 'S' } });
  });

  it('funções do projeto vencem as globais e vão para o workspace', async () => {
    const { dir } = await withRegent();
    await bridge!.dispatchForTest('persona.write', { name: 'p', text: 'global', global: true }, { session: 'R' });
    await bridge!.dispatchForTest('persona.write', { name: 'p', text: 'projeto', global: false }, { session: 'R' });
    await expect(bridge!.dispatchForTest('persona.show', { name: 'p' }, { session: 'R' })).resolves.toEqual({ name: 'p', scope: 'project', text: 'projeto' });
    await expect(bridge!.dispatchForTest('persona.list', {}, { session: 'R' })).resolves.toEqual({ personas: [{ name: 'p', scope: 'project' }] });
    await bridge!.close();
    bridge = undefined;
    expect(readWorkspace(dir)).toMatchObject({ personas: [{ name: 'p', text: 'projeto' }], terminals: [expect.objectContaining({ name: 'R', regente: true })] });
  });

  it('restaurar o workspace não reentrega a função', async () => {
    const first = await withRegent();
    await bridge!.dispatchForTest('persona.write', { name: 'p', text: 'Texto.', global: false }, { session: 'R' });
    await bridge!.dispatchForTest('regent.new', { name: 'C', agent: 'claude', persona: 'p' }, { session: 'R' });
    await bridge!.close();
    bridge = undefined;
    const second = await setup({ adapters: { shell: shellAdapter(), claude: agentAdapter() } });
    await second.command('1', 'project.open', { dir: first.dir });
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const { pty } of second.ptyHost.spawned) expect(pty.written.join('')).not.toContain('[orq] Sua função');
  });

  it('persona.write com texto vazio devolve USAGE e mantém workspace válido', async () => {
    const { dir } = await withRegent();
    await expect(bridge!.dispatchForTest('persona.write', { name: 'invalida', text: '', global: false }, { session: 'R' })).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringMatching(/Função inválida:.*texto.*vazio/),
    });
    await bridge!.close();
    bridge = undefined;
    const second = await setup({ adapters: { shell: shellAdapter(), claude: agentAdapter() } });
    const response = await second.command('1', 'project.open', { dir });
    expect(response).toMatchObject({ kind: 'response' });
    expect(second.sent).not.toContainEqual(
      expect.objectContaining({
        kind: 'event',
        event: expect.objectContaining({ type: 'notice', level: 'warn', message: expect.stringMatching(/workspace.*inválido/) }),
      }),
    );
  });

  it('remover nota pelo regente emite note.removed e notice', async () => {
    const { sent, command } = await withRegent();
    await command('4', 'note.create', { name: 'anotacao', content: 'texto' });
    await bridge!.dispatchForTest('regent.remove', { name: 'anotacao' }, { session: 'R' });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'note.removed', name: 'anotacao' } });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'notice', level: 'info', message: 'R removeu anotacao.' } });
  });

  it('criar shell regente funciona e não entrega guia', async () => {
    const { command, ptyHost } = await setup({ adapters: { shell: shellAdapter(), claude: agentAdapter() } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    const response = await command('2', 'terminal.create', { name: 'S', agent: 'shell', regente: true });
    expect(response).toMatchObject({
      kind: 'response',
      id: '2',
      ok: true,
      result: expect.objectContaining({ name: 'S', agent: 'shell', regente: true }),
    });
    expect(ptyHost.last().written.join('')).toBe('');
  });

  it('monitor vai no info e no workspace', async () => {
    const { command } = await setup({ adapters: { shell: { ...createFakeAdapter(), kind: 'shell' } } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    expect(await command('2', 'terminal.create', { name: 'A', agent: 'shell', monitor: true })).toMatchObject({ result: { monitor: true } });
    await command('3', 'terminal.update', { name: 'A', monitor: false });
    await bridge!.close();
    bridge = undefined;
    expect(readWorkspace(dir).terminals[0]).toMatchObject({ name: 'A', monitor: false });
  });

  it('fim de turno do usuário chega à interface como terminal.turn', async () => {
    const { command, sent, ptyHost } = await setup({ adapters: { shell: { ...createFakeAdapter(), kind: 'shell' } } });
    const dir = mkdtempSync(join(tmpdir(), 'orq-proj-'));
    await command('1', 'project.open', { dir });
    await command('2', 'terminal.create', { name: 'A', agent: 'shell' });
    ptyHost.last().emitData('pronto> ');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await command('3', 'terminal.input', { name: 'A', data: 'oi\r' });
    const env = ptyHost.spawned.at(-1)!.spec.env;
    await call({ pipePath: env.ORQ_PIPE!, token: env.ORQ_TOKEN! }, 'hook', { agent: 'shell', event: 'Stop', payload: {} });
    expect(sent).toContainEqual({ kind: 'event', event: { type: 'terminal.turn', name: 'A', owner: 'user', outcome: 'ended' } });
  });
});


