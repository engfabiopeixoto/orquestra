import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { createOrquestra, type Orquestra, type OrquestraEvent, type OrquestraOptions, type RegentHandler } from '../src/orquestra.js';
import { createFakeAdapter } from './helpers/fake-adapter.js';
import { FakePtyHost } from './helpers/fake-pty-host.js';
import { waitFor } from './helpers/wait.js';

let orquestra: Orquestra | undefined;
afterEach(async () => {
  await orquestra?.close();
  orquestra = undefined;
});

async function setupOrquestra(extra: Partial<OrquestraOptions> = {}) {
  const host = new FakePtyHost();
  const events: OrquestraEvent[] = [];
  orquestra = await createOrquestra({
    pipePath: `\\\\.\\pipe\\orq-unit-${randomBytes(4).toString('hex')}`,
    dataDir: mkdtempSync(join(tmpdir(), 'orq-unit-')),
    cliScript: 'C:/orq/bin/orq.mjs',
    adapters: { fake: createFakeAdapter() },
    log: silentLogger(),
    ptyHost: host,
    readyQuietMs: 20,
    typingGuardMs: 0,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { orq: orquestra, host, events };
}

describe('Orquestra (PTY falso)', () => {
  it('hook aponta para o CLI inteiro quando a instalação tem espaços', async () => {
    const { orq, host } = await setupOrquestra({ cliScript: 'C:/Program Files/Orquestra/orq.mjs' });
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    expect(host.spawned[0]!.spec.env.FAKE_HOOK_CMD).toBe('node "C:/Program Files/Orquestra/orq.mjs" hook fake Stop');
  });

  it('fila durante starting drena em ordem e publica contagem zero no fim', async () => {
    const { orq, host, events } = await setupOrquestra();
    const b = orq.createTerminal({ name: 'B', agent: 'fake', cwd: tmpdir() });
    const first = orq.broker.submit({ asker: 'A', target: 'B', text: 'primeiro', timeoutMs: 10_000 });
    const second = orq.broker.submit({ asker: 'C', target: 'B', text: 'segundo', timeoutMs: 10_000 });
    expect(orq.broker.queued('B')).toBe(2);
    await waitFor(() => host.spawned[0]!.pty.written.includes('\r'));
    await b.handleHook('Stop', { last_assistant_message: 'resposta 1' });
    await expect(first).resolves.toMatchObject({ answer: 'resposta 1' });
    await waitFor(() => host.spawned[0]!.pty.written.filter((text) => text === '\r').length === 2);
    await b.handleHook('Stop', { last_assistant_message: 'resposta 2' });
    await expect(second).resolves.toMatchObject({ answer: 'resposta 2' });
    expect(orq.broker.queued('B')).toBe(0);
    expect(events.filter((event) => event.type === 'state').at(-1)).toMatchObject({ name: 'B', state: 'idle', queued: 0 });
    expect(events.filter((event) => event.type === 'queue').at(-1)).toMatchObject({ name: 'B', entries: [] });
  });
  it('descarregar mantém o nó, invalida a credencial antiga e recarrega com as conexões', async () => {
    const { orq, host } = await setupOrquestra();
    const a = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), agentSessionId: 'history-A' });
    orq.createTerminal({ name: 'B', agent: 'fake', cwd: tmpdir() });
    orq.connect('A', 'B');
    const token = orq.tokenFor('A');
    await orq.unloadTerminal('A');
    expect(a.state).toBe('exited');
    expect(orq.topology.isConnected('A', 'B')).toBe(true);
    expect(orq.describeTerminals().find((terminal) => terminal.name === 'A')).toMatchObject({ unloaded: true, agentSessionId: 'history-A' });
    const loaded = await orq.restartTerminal('A');
    expect(loaded.id).toBe(a.id);
    expect(orq.tokenFor('A')).not.toBe(token);
    expect(orq.describeTerminals().find((terminal) => terminal.name === 'A')?.unloaded).toBeUndefined();
    expect(orq.topology.isConnected('A', 'B')).toBe(true);
    expect(host.spawned.at(-1)?.spec.args).toContain('history-A');
  });
  it('restaurar um terminal descarregado não inicia um processo', async () => {
    const { orq, host } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), unloaded: true, agentSessionId: 'history-A' });
    expect(host.spawned).toHaveLength(0);
    expect(session.state).toBe('exited');
    expect(session.agentSessionId).toBe('history-A');
    expect(orq.describeTerminals()[0]?.unloaded).toBe(true);
  });
  it('editar os argumentos de um terminal descarregado não o inicia', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), unloaded: true });
    await orq.updateTerminal('A', { args: ['--new'], newName: 'renomeado' });
    expect(host.spawned).toHaveLength(0);
    expect(orq.describeTerminals()[0]).toMatchObject({ name: 'renomeado', unloaded: true, args: ['--new'] });
    expect(orq.session('renomeado')?.state).toBe('exited');
  });
  it('remover o terminal tira os ouvintes da sessão antes de encerrá-la', async () => {
    const { orq } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    await orq.removeTerminal('A');
    expect(session.listenerCount('turnFailed')).toBe(0);
    expect(session.listenerCount('state')).toBe(0);
  });

  it('saída que chega depois de remover o terminal não chega a ouvintes nem ao agrupador', async () => {
    const { orq, host, events } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    await orq.removeTerminal('A');
    host.spawned[0]?.pty.emitData('saída tardia');
    const outputs = events.filter((e) => e.type === 'output');
    expect(outputs).toEqual([]);
  });

  it('renomeia mantendo conexões e recusa com fila', async () => {
    const { orq } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createTerminal({ name: 'B', agent: 'fake', cwd: tmpdir() });
    orq.connect('A', 'B');
    const renamed = orq.renameTerminal('A', 'C');
    expect(renamed.name).toBe('C');
    expect(orq.topology.isConnected('C', 'B')).toBe(true);
    expect(orq.tokenFor('C')).toBeDefined();
    expect(orq.tokenFor('A')).toBeUndefined();
  });

  it('renomear para o mesmo nome é no-op no núcleo e não dá erro', async () => {
    const { orq } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    const session = orq.renameTerminal('A', 'A');
    expect(session.name).toBe('A');
  });

  it('renomear e reiniciar não anunciam remoção (a interface perderia o nó)', async () => {
    const { orq, events } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.renameTerminal('A', 'C');
    await orq.restartTerminal('C');
    expect(events.filter((event) => event.type === 'removed')).toEqual([]);
  });

  it('reiniciar cria um PTY novo com o mesmo nome e as mesmas conexões', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createTerminal({ name: 'B', agent: 'fake', cwd: tmpdir() });
    orq.connect('A', 'B');
    const before = host.spawned.length;
    const restarted = await orq.restartTerminal('A');
    expect(host.spawned.length).toBe(before + 1);
    expect(restarted.name).toBe('A');
    expect(orq.topology.isConnected('A', 'B')).toBe(true);
  });

  it('emite saída, estado e remoção pelo onEvent', async () => {
    const { orq, host, events } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    host.last().emitData('olá');
    await waitFor(() => events.some((event) => event.type === 'state' && event.state === 'idle'));
    expect(events).toContainEqual({ type: 'output', name: 'A', data: 'olá' });
    await orq.removeTerminal('A');
    expect(events).toContainEqual({ type: 'removed', name: 'A' });
  });

  it('o retrato da sessão traz o texto da tela', async () => {
    const { orq, host } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    host.last().emitData('tela de A');
    await waitFor(() => session.screenText().includes('tela de A'));
    expect(session.snapshot()).toMatchObject({ cols: 120, rows: 40 });
    expect(session.snapshot().data).toContain('tela de A');
  });

  it('reinício que falha anuncia a remoção, para a interface não ficar com um nó fantasma', async () => {
    const { orq, events } = await setupOrquestra();
    const cwd = mkdtempSync(join(tmpdir(), 'orq-restart-'));
    orq.createTerminal({ name: 'A', agent: 'fake', cwd });
    rmSync(cwd, { recursive: true });
    await expect(orq.restartTerminal('A')).rejects.toMatchObject({ code: 'USAGE' });
    expect(events).toContainEqual({ type: 'removed', name: 'A' });
    expect(orq.session('A')).toBeUndefined();
  });

  it('a sessão chega a idle com o PTY falso', async () => {
    const { orq, host } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
  });

  it('descreve os terminais com id, retomada e args, e relança com retomada', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), id: '11111111-1111-4111-8111-111111111111', resume: true, agentSessionId: 's-1', args: ['--x'] });
    expect(host.spawned[0]!.spec.args.slice(-3)).toEqual(['--resume', 's-1', '--x']);
    expect(orq.describeTerminals()).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', name: 'A', agent: 'fake', cwd: tmpdir(), args: ['--x'], resume: true, agentSessionId: 's-1', regente: false, persona: null, monitor: false },
    ]);
    await orq.restartTerminal('A');
    expect(host.spawned[1]!.spec.args).toContain('--resume');
  });

  it('sem retomada ligada, não retoma mesmo com id', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), resume: false, agentSessionId: 's-1' });
    expect(host.spawned[0]!.spec.args).not.toContain('--resume');
  });

  it('agente retomado que sai cedo é relançado sem retomar e o núcleo avisa', async () => {
    const { orq, host, events } = await setupOrquestra({ resumeGraceMs: 1000 });
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), resume: true, agentSessionId: 's-velho' });
    host.last().emitExit(1);
    await waitFor(() => host.spawned.length === 2);
    expect(host.spawned[1]!.spec.args).not.toContain('--resume');
    expect(orq.describeTerminals()[0]!.agentSessionId).toBeNull();
    expect(events).toContainEqual({ type: 'notice', name: 'A', message: expect.stringMatching(/a sessão anterior não pôde ser retomada/) });
  });

  it('agente retomado que sai depois do prazo não é relançado', async () => {
    const { orq, host } = await setupOrquestra({ resumeGraceMs: 20 });
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), resume: true, agentSessionId: 's-1' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    host.last().emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host.spawned).toHaveLength(1);
  });

  it('id novo da sessão do agente gera evento agent-session', async () => {
    const { orq, events } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    session.emit('agentSession', 'novo');
    expect(events).toContainEqual({ type: 'agent-session', name: 'A' });
    expect(orq.describeTerminals()[0]!.agentSessionId).toBe('novo');
  });

  it('nota criada pelo orq gera evento com o autor; nota da interface não', async () => {
    const { orq, events } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    const dispatch = orq.dispatchForTest;
    await dispatch('note.write', { name: 'plano', content: '# x' }, { session: 'A' }, new AbortController().signal);
    expect(events).toContainEqual({ type: 'note', note: expect.objectContaining({ name: 'plano', updatedBy: 'A', revision: 1 }), createdBy: 'A' });
    await dispatch('note.append', { name: 'plano', content: '!' }, { session: 'A' }, new AbortController().signal);
    expect(events).toContainEqual({ type: 'note', note: expect.objectContaining({ revision: 2 }), createdBy: null });
    const count = events.length;
    orq.saveNote('plano', 'da interface', 2);
    expect(events).toHaveLength(count);
  });

  it('restoreNote põe a nota no canvas com id e revisão', async () => {
    const { orq } = await setupOrquestra();
    orq.restoreNote({ id: 'id-1', name: 'plano', content: 'x', revision: 4, updatedBy: 'A' });
    expect(orq.topology.kindOf('plano')).toBe('note');
    expect(orq.notes.get('plano')).toEqual({ id: 'id-1', name: 'plano', content: 'x', revision: 4, updatedBy: 'A' });
  });

  it('removeNote tira a nota e as conexões', async () => {
    const { orq } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createNote('plano', '');
    orq.connect('A', 'plano');
    orq.removeNote('plano');
    expect(orq.notes.get('plano')).toBeUndefined();
    expect(orq.topology.kindOf('plano')).toBeUndefined();
    expect(orq.topology.neighbors('A')).toEqual([]);
  });

  it('update só de nome e retomada não relança', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), args: ['--x'] });
    await orq.updateTerminal('A', { newName: 'B', resume: false });
    expect(host.spawned).toHaveLength(1);
    expect(orq.describeTerminals()).toEqual([expect.objectContaining({ name: 'B', resume: false, args: ['--x'] })]);
  });

  it('update de argumentos relança com os argumentos novos e retomando', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), args: ['--velho'], agentSessionId: 's-1' });
    await orq.updateTerminal('A', { args: ['--novo'] });
    expect(host.spawned).toHaveLength(2);
    expect(host.spawned[1]!.spec.args.slice(-3)).toEqual(['--resume', 's-1', '--novo']);
    expect(orq.describeTerminals()[0]).toMatchObject({ name: 'A', args: ['--novo'] });
  });

  it('update de pasta relança na pasta nova; renomear e relançar juntos mantêm as conexões', async () => {
    const { orq, host } = await setupOrquestra();
    const other = mkdtempSync(join(tmpdir(), 'orq-cwd-'));
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createTerminal({ name: 'C', agent: 'fake', cwd: tmpdir() });
    orq.connect('A', 'C');
    await orq.updateTerminal('A', { newName: 'B', cwd: other });
    expect(host.spawned.at(-1)!.spec.cwd).toBe(other);
    expect(orq.topology.neighbors('B')).toEqual(['C']);
  });

  it('validação acontece antes de qualquer mudança', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createTerminal({ name: 'C', agent: 'fake', cwd: tmpdir() });
    await expect(orq.updateTerminal('A', { newName: 'B', cwd: join(tmpdir(), 'nao-existe-orq') })).rejects.toThrow(/A pasta .* não existe/);
    await expect(orq.updateTerminal('A', { newName: 'C' })).rejects.toThrow(/Já existe um nó chamado C/);
    expect(orq.describeTerminals().map((terminal) => terminal.name)).toEqual(['A', 'C']);
    expect(host.spawned).toHaveLength(2);
  });

  it('argumento reservado é recusado na criação e na edição de um claude', async () => {
    const { orq } = await setupOrquestra({ adapters: { claude: { ...createFakeAdapter(), kind: 'claude' } } });
    expect(() => orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), args: ['--resume'] })).toThrow(/--resume é controlado pelo Orquestra/);
    expect(orq.topology.kindOf('A')).toBeUndefined();
    orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir() });
    await expect(orq.updateTerminal('A', { args: ['--settings=x'] })).rejects.toThrow(/--settings é controlado/);
  });

  it('regente e persona entram no descritor; regente muda sem relançar', async () => {
    const { orq, host } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir(), regente: true, persona: 'revisor' });
    expect(orq.describeTerminals()[0]).toMatchObject({ regente: true, persona: 'revisor' });
    await orq.updateTerminal('A', { regente: false });
    expect(host.spawned).toHaveLength(1);
    expect(orq.describeTerminals()[0]).toMatchObject({ regente: false });
  });

  it('remover com motivo falha os pedidos em andamento com o motivo', async () => {
    const { orq } = await setupOrquestra();
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    orq.createTerminal({ name: 'B', agent: 'fake', cwd: tmpdir() });
    orq.connect('A', 'B');
    const pending = orq.broker.submit({ asker: 'A', target: 'B', text: 'x', timeoutMs: 60_000 });
    await orq.removeTerminal('B', { reason: 'removido por R' });
    await expect(pending).rejects.toThrow(/removido por R/);
  });

  it('brief recusa terminal inexistente e shell', async () => {
    const { orq } = await setupOrquestra({ adapters: { fake: createFakeAdapter(), shell: { ...createFakeAdapter(), kind: 'shell', acceptsPrompts: false } } });
    orq.createTerminal({ name: 'S', agent: 'shell', cwd: tmpdir() });
    expect(() => orq.brief('X', 'R', 'oi')).toThrow(/não existe/);
    expect(() => orq.brief('S', 'R', 'oi')).toThrow('O shell não recebe funções.');
  });

  it('terminal comum recebe NOT_REGENT e o callback não é chamado', async () => {
    const calls: string[] = [];
    const { orq } = await setupOrquestra({ regent: (async (method: string) => { calls.push(method); return { name: 'X' }; }) as RegentHandler });
    orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    await expect(orq.dispatchForTest('regent.new', { name: 'X', agent: 'shell' }, { session: 'A' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'NOT_REGENT',
      message: 'A não é regente. Marque a opção "Regente" no terminal para usar este comando.',
    });
    expect(calls).toEqual([]);
  });

  it('regente tem o comando repassado ao callback com o nome de quem chamou', async () => {
    const calls: Array<[string, unknown, string]> = [];
    const { orq } = await setupOrquestra({ regent: (async (method: string, params: unknown, caller: string) => { calls.push([method, params, caller]); return { name: 'X' }; }) as RegentHandler });
    orq.createTerminal({ name: 'R', agent: 'fake', cwd: tmpdir(), regente: true });
    await expect(orq.dispatchForTest('regent.new', { name: 'X', agent: 'shell' }, { session: 'R' }, new AbortController().signal)).resolves.toEqual({ name: 'X' });
    expect(calls).toEqual([['regent.new', { name: 'X', agent: 'shell' }, 'R']]);
  });

  it('sem app (sem callback), comandos de regente são UNSUPPORTED', async () => {
    const { orq } = await setupOrquestra();
    orq.createTerminal({ name: 'R', agent: 'fake', cwd: tmpdir(), regente: true });
    await expect(orq.dispatchForTest('persona.list', {}, { session: 'R' }, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('monitor tem padrão pelo tipo e muda sem relançar', async () => {
    const { orq, host } = await setupOrquestra({ adapters: { fake: createFakeAdapter(), claude: { ...createFakeAdapter(), kind: 'claude' } } });
    orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir() });
    orq.createTerminal({ name: 'F', agent: 'fake', cwd: tmpdir() });
    expect(orq.describeTerminals().map((terminal) => terminal.monitor)).toEqual([true, false]);
    await orq.updateTerminal('A', { monitor: false });
    expect(host.spawned).toHaveLength(2);
    expect(orq.describeTerminals()[0]!.monitor).toBe(false);
  });

  it('fim de turno vira evento turn com dono e resultado', async () => {
    const { orq, events } = await setupOrquestra();
    const session = orq.createTerminal({ name: 'A', agent: 'fake', cwd: tmpdir() });
    session.emit('turnEnded', { owner: 'user', answer: null });
    session.emit('turnFailed', { owner: 'broker', reason: 'interrupted' });
    expect(events).toContainEqual({ type: 'turn', name: 'A', owner: 'user', outcome: 'ended' });
    expect(events).toContainEqual({ type: 'turn', name: 'A', owner: 'broker', outcome: 'failed' });
  });
});
