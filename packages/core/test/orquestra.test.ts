import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    claudeDir: mkdtempSync(join(tmpdir(), 'orq-claude-')),
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

describe('conversa do Claude em segundo plano (daemon)', () => {
  const SESSION = '793b7407-bcc4-4c5a-ac40-180664d399cd';
  const NOTICE = 'Conversa em segundo plano: sem conexão com o Orquestra. Rode `claude stop 793b7407` e reinicie este terminal.';
  const LIVE_PIPE = 'cc-daemon-bc8e3d6ca88bafb5-pty-793b7407';
  const claudeAdapters = () => ({ claude: { ...createFakeAdapter(), kind: 'claude' } });
  const setup = async () => {
    let pipes = [LIVE_PIPE];
    const setPipes = (next: string[]) => { pipes = next; };
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    const writeJob = (state: Record<string, unknown>) => {
      const id = String(state.sessionId ?? SESSION).slice(0, 8);
      mkdirSync(join(claudeDir, 'jobs', id), { recursive: true });
      writeFileSync(join(claudeDir, 'jobs', id, 'state.json'), JSON.stringify(state));
    };
    const removeJob = (id8 = SESSION.slice(0, 8)) => rmSync(join(claudeDir, 'jobs', id8), { recursive: true, force: true });
    const env = await setupOrquestra({ adapters: claudeAdapters(), claudeDir, backgroundJobPollMs: 30, listPipes: () => pipes });
    return { ...env, writeJob, removeJob, setPipes };
  };
  const notices = (events: OrquestraEvent[]) => events.filter((event) => event.type === 'notice').map((event) => (event as { message: string }).message);

  it('avisa no terminal, registra o job na sessão e recusa prompts sem tirar o terminal de idle', async () => {
    const { orq, host, events, writeJob } = await setup();
    const session = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    await waitFor(() => notices(events).includes(NOTICE));
    expect(session.backgroundJob).toEqual({ id8: '793b7407', state: 'working' });
    expect(session.state).toBe('idle');
    await expect(orq.broker.submit({ asker: 'B', target: 'A', text: 'oi', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'PROMPT_FAILED', message: expect.stringContaining('claude stop 793b7407') });
    expect(host.last().written).toEqual([]);
  });

  it('limpa o aviso quando o job some e volta a atender prompts', async () => {
    const { orq, host, events, writeJob, removeJob } = await setup();
    const session = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    await waitFor(() => session.backgroundJob !== null);
    removeJob();
    await waitFor(() => session.backgroundJob === null);
    expect(notices(events).at(-1)).toBe('');
    void orq.broker.submit({ asker: 'B', target: 'A', text: 'de volta', timeoutMs: 1000 }).catch(() => {});
    await waitFor(() => host.last().written.includes('\r'));
  });

  it('ignora o job de outra sessão (mesmo prefixo de id)', async () => {
    const { orq, host, events, writeJob } = await setup();
    const session = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    host.last().emitData('pronto> ');
    writeJob({ backend: 'daemon', state: 'working', sessionId: '793b7407-ffff-ffff-ffff-ffffffffffff' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.backgroundJob).toBeNull();
    expect(notices(events)).toEqual([]);
  });

  it('job antigo sem processo vivo não avisa nem bloqueia a retomada (done, ou working sem pipe)', async () => {
    const { orq, host, events, writeJob, setPipes } = await setup();
    writeJob({ backend: 'daemon', state: 'done', sessionId: SESSION });
    const done = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    expect(host.spawned).toHaveLength(1);
    expect(done.state).not.toBe('exited');
    setPipes([]);
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    const dead = orq.createTerminal({ name: 'B', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    expect(host.spawned).toHaveLength(2);
    expect(dead.state).not.toBe('exited');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notices(events)).toEqual([]);
    expect(done.backgroundJob).toBeNull();
    expect(dead.backgroundJob).toBeNull();
  });

  it('reemite o aviso a cada verificação enquanto o job existir (a interface pode ter recarregado)', async () => {
    const { orq, events, writeJob } = await setup();
    orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    await waitFor(() => notices(events).filter((message) => message === NOTICE).length >= 3);
  });

  it('não abre uma segunda cópia ao retomar uma sessão presa ao daemon: o terminal fica descarregado com o aviso', async () => {
    const { orq, host, events, writeJob } = await setup();
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    const session = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    expect(host.spawned).toHaveLength(0);
    expect(session.state).toBe('exited');
    expect(orq.describeTerminals()[0]).toMatchObject({ name: 'A', unloaded: true, agentSessionId: SESSION });
    await waitFor(() => notices(events).includes(NOTICE));
  });

  it('reiniciar volta a lançar claude --resume depois que o job parou', async () => {
    const { orq, host, writeJob, removeJob } = await setup();
    const first = orq.createTerminal({ name: 'A', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    host.last().emitData('pronto> ');
    writeJob({ backend: 'daemon', state: 'working', sessionId: SESSION });
    await waitFor(() => first.backgroundJob !== null);
    const blocked = await orq.restartTerminal('A');
    expect(blocked.state).toBe('exited');
    expect(host.spawned).toHaveLength(1);
    removeJob();
    await waitFor(() => blocked.backgroundJob === null);
    const resumed = await orq.restartTerminal('A');
    expect(host.spawned).toHaveLength(2);
    expect(host.spawned[1]!.spec.args).toContain(SESSION);
    expect(resumed.state).not.toBe('exited');
  });
});

// Validação real (Claude Code 2.1.299): o /bg cria o job com sessionId novo e o processo local sai em ~3 s.
describe('conversa em segundo plano com sessionId novo (vínculo pelo sessionDir)', () => {
  const OLD_SESSION = '606c1b68-0000-4000-8000-000000000001';
  const JOB_SESSION = 'b845e5a9-0000-4000-8000-000000000002';
  const JOB_PIPE = 'cc-daemon-bc8e3d6ca88bafb5-pty-b845e5a9';
  const NOTICE = 'Conversa em segundo plano: sem conexão com o Orquestra. Rode `claude stop b845e5a9` e reinicie este terminal.';
  const setup = async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    const launchDirs: string[] = [];
    const base = createFakeAdapter();
    const adapter = { ...base, kind: 'claude', launch: (ctx: Parameters<typeof base.launch>[0]) => { launchDirs.push(ctx.sessionDir); return base.launch(ctx); } };
    const writeJob = (state: string, dir = launchDirs.at(-1)!) => {
      mkdirSync(join(claudeDir, 'jobs', 'b845e5a9'), { recursive: true });
      writeFileSync(join(claudeDir, 'jobs', 'b845e5a9', 'state.json'), JSON.stringify({
        backend: 'daemon', state, sessionId: JOB_SESSION, resumeSessionId: JOB_SESSION,
        respawnFlags: ['--settings', join(dir, 'claude-settings.json'), '--permission-mode', 'bypassPermissions'],
      }));
    };
    const env = await setupOrquestra({ adapters: { claude: adapter }, claudeDir, backgroundJobPollMs: 30, listPipes: () => [JOB_PIPE] });
    return { ...env, launchDirs, writeJob };
  };
  const notices = (events: OrquestraEvent[]) => events.filter((event) => event.type === 'notice').map((event) => (event as { message: string }).message);

  it('terminal encerrado pelo /bg com o job vivo: avisa e recusa prompt e brief com a mensagem de segundo plano', async () => {
    const { orq, host, events, writeJob } = await setup();
    const session = orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: OLD_SESSION });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    writeJob('working');
    host.last().emitExit(0);
    expect(session.state).toBe('exited');
    await waitFor(() => notices(events).includes(NOTICE));
    expect(session.backgroundJob).toEqual({ id8: 'b845e5a9', state: 'working' });
    const refused = orq.broker.submit({ asker: 'X', target: 'W', text: 'oi', timeoutMs: 1000 });
    await expect(refused).rejects.toMatchObject({ code: 'PROMPT_FAILED', message: expect.stringContaining('claude stop b845e5a9') });
    await expect(refused).rejects.toThrow(/segundo plano/);
    expect(() => orq.brief('W', 'X', 'função')).toThrow(/segundo plano/);
  });

  it('reiniciar com o job vivo não lança o claude; com o job parado, retoma normalmente', async () => {
    const { orq, host, events, writeJob } = await setup();
    const first = orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: OLD_SESSION });
    host.last().emitData('pronto> ');
    writeJob('working');
    host.last().emitExit(0);
    await waitFor(() => first.backgroundJob !== null);
    expect(host.spawned).toHaveLength(1);

    const blocked = await orq.restartTerminal('W');
    expect(host.spawned).toHaveLength(1);
    expect(blocked.state).toBe('exited');
    expect(orq.describeTerminals()[0]).toMatchObject({ name: 'W', unloaded: true, agentSessionId: OLD_SESSION });
    await waitFor(() => blocked.backgroundJob !== null);
    // Reiniciar de novo, ainda com o job vivo, continua bloqueado: o vínculo sobrevive ao relançamento.
    const again = await orq.restartTerminal('W');
    expect(host.spawned).toHaveLength(1);
    await waitFor(() => again.backgroundJob !== null);

    writeJob('stopped');
    await waitFor(() => again.backgroundJob === null);
    expect(notices(events).at(-1)).toBe('');
    const resumed = await orq.restartTerminal('W');
    expect(host.spawned).toHaveLength(2);
    expect(host.spawned[1]!.spec.args).toContain(OLD_SESSION);
    expect(resumed.state).not.toBe('exited');
  });

  it('job vivo cujo --settings aponta para outro lançamento não bloqueia nem avisa', async () => {
    const { orq, host, events, writeJob } = await setup();
    const first = orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: OLD_SESSION });
    writeJob('working', join(tmpdir(), 'sessions', 'de-outro-terminal'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(first.backgroundJob).toBeNull();
    expect(notices(events)).toEqual([]);
    expect(host.spawned).toHaveLength(1);
  });
});

describe('pastas de sessão persistidas (sobrevivem a fechar e abrir o app)', () => {
  const OLD_SESSION = '606c1b68-0000-4000-8000-000000000001';
  const JOB_PIPE = 'cc-daemon-bc8e3d6ca88bafb5-pty-b845e5a9';
  const NOTICE = 'Conversa em segundo plano: sem conexão com o Orquestra. Rode `claude stop b845e5a9` e reinicie este terminal.';
  const writeJob = (claudeDir: string, state: string, sessionDir: string) => {
    mkdirSync(join(claudeDir, 'jobs', 'b845e5a9'), { recursive: true });
    writeFileSync(join(claudeDir, 'jobs', 'b845e5a9', 'state.json'), JSON.stringify({
      backend: 'daemon', state, sessionId: 'b845e5a9-0000-4000-8000-000000000002',
      respawnFlags: ['--settings', join(sessionDir, 'claude-settings.json')],
    }));
  };
  const open = (claudeDir: string) => setupOrquestra({ adapters: { claude: { ...createFakeAdapter(), kind: 'claude' } }, claudeDir, backgroundJobPollMs: 30, listPipes: () => [JOB_PIPE] });

  it('describeTerminals publica a pasta de cada lançamento, no máximo 20', async () => {
    const { orq } = await open(mkdtempSync(join(tmpdir(), 'orq-claude-')));
    orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: OLD_SESSION });
    expect(orq.describeTerminals()[0]!.sessionDirs).toHaveLength(1);
    await orq.restartTerminal('W');
    const afterRestart = orq.describeTerminals()[0]!.sessionDirs!;
    expect(afterRestart).toHaveLength(2);
    expect(new Set(afterRestart).size).toBe(2);
    for (let index = 0; index < 22; index++) await orq.restartTerminal('W');
    const capped = orq.describeTerminals()[0]!.sessionDirs!;
    expect(capped).toHaveLength(20);
    expect(capped.at(-1)).not.toBe(afterRestart.at(-1));
  });

  it('reabrir com o job vivo apontando para um sessionDir antigo deixa o terminal descarregado, sem lançar o claude', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    const first = await open(claudeDir);
    first.orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: OLD_SESSION });
    // O que o host grava no workspace e lê de volta (snapshot e restore).
    const saved = JSON.parse(JSON.stringify(first.orq.describeTerminals()[0]));
    expect(saved.sessionDirs).toHaveLength(1);
    await first.orq.close();

    // O app reinicia: o job do daemon sobreviveu e aponta para o lançamento antigo.
    writeJob(claudeDir, 'working', saved.sessionDirs[0]);
    const second = await open(claudeDir);
    const session = second.orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), id: saved.id, agentSessionId: saved.agentSessionId, resume: saved.resume, sessionDirs: saved.sessionDirs });
    expect(second.host.spawned).toHaveLength(0);
    expect(session.state).toBe('exited');
    expect(second.orq.describeTerminals()[0]).toMatchObject({ name: 'W', unloaded: true });
    await waitFor(() => second.events.some((event) => event.type === 'notice' && event.message === NOTICE));

    // Sem o campo (workspace antigo), o job não é reconhecido e a retomada segue como antes.
    await second.orq.removeTerminal('W');
    const legacy = second.orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: saved.agentSessionId });
    expect(second.host.spawned).toHaveLength(1);
    expect(legacy.state).not.toBe('exited');
  });
});

// Claude Code 2.1.300: Esc antes do primeiro token desfaz o turno, devolve o texto à caixa de entrada e
// não dispara Stop nem mostra "Interrupted". A fonte confiável é o status em ~/.claude/sessions/<pid>.json.
describe('Esc antes do primeiro token (status da sessão do Claude)', () => {
  const SESSION = 'fa074cce-7d86-4ac6-a126-f21d6319d70e';
  const setup = async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const setStatus = (pid: number, status: string) => writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, status, kind: 'interactive' }));
    const env = await setupOrquestra({ adapters: { claude: { ...createFakeAdapter(), kind: 'claude' } }, claudeDir, claudeStatusPollMs: 20, claudeIdleGraceMs: 150, listPipes: () => [] });
    const session = env.orq.createTerminal({ name: 'W', agent: 'claude', cwd: tmpdir(), agentSessionId: SESSION });
    env.host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    return { ...env, session, setStatus, pid: session.pid };
  };

  it('o pedido em curso falha como interrompido e a fila destrava', async () => {
    const { orq, host, session, setStatus, pid } = await setup();
    const first = orq.broker.submit({ asker: 'S', target: 'W', text: 'primeiro', timeoutMs: 10_000 });
    const second = orq.broker.submit({ asker: 'S', target: 'W', text: 'segundo', timeoutMs: 10_000 });
    const failure = expect(first).rejects.toMatchObject({ code: 'PROMPT_FAILED', message: expect.stringContaining('interrompido') });
    await waitFor(() => host.last().written.includes('\r'));
    expect(orq.broker.queued('W')).toBe(2);
    setStatus(pid, 'busy');
    await new Promise((resolve) => setTimeout(resolve, 80));
    setStatus(pid, 'idle');
    await failure;
    // O segundo pedido é entregue ao terminal liberado.
    await waitFor(() => host.last().written.filter((text) => text === '\r').length === 2);
    expect(session.state).toBe('busy');
    void second.catch(() => {});
    // O Claude devolve o texto do pedido desfeito à caixa de entrada: Ctrl+C a limpa antes do próximo pedido.
    const ctrlC = String.fromCharCode(3);
    const written = host.last().written;
    expect(written.filter((text) => text === ctrlC)).toHaveLength(1);
    expect(written.indexOf(ctrlC)).toBeGreaterThan(written.indexOf('\r'));
    expect(written.lastIndexOf('\r')).toBeGreaterThan(written.indexOf(ctrlC));
  });

  it('turno do próprio usuário interrompido não tem a caixa limpa: o texto devolvido é dele', async () => {
    const { host, session, setStatus, pid } = await setup();
    session.userInput('meu pedido');
    session.userInput('\r');
    expect(session.state).toBe('busy');
    setStatus(pid, 'busy');
    await new Promise((resolve) => setTimeout(resolve, 80));
    setStatus(pid, 'idle');
    await waitFor(() => session.state === 'idle');
    expect(host.last().written).not.toContain(String.fromCharCode(3));
  });

  it('turno que termina com Stop logo depois do idle é respondido, não interrompido', async () => {
    const { orq, host, session, setStatus, pid } = await setup();
    const answer = orq.broker.submit({ asker: 'S', target: 'W', text: 'pedido', timeoutMs: 10_000 });
    await waitFor(() => host.last().written.includes('\r'));
    setStatus(pid, 'busy');
    await new Promise((resolve) => setTimeout(resolve, 80));
    setStatus(pid, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await session.handleHook('Stop', { last_assistant_message: 'pronto' });
    await expect(answer).resolves.toMatchObject({ status: 'answered', answer: 'pronto' });
  });

  it('idle antes de qualquer ocupado (claude ainda processando o prompt) não interrompe o turno', async () => {
    const { orq, host, session, setStatus, pid } = await setup();
    const answer = orq.broker.submit({ asker: 'S', target: 'W', text: 'pedido', timeoutMs: 10_000 });
    await waitFor(() => host.last().written.includes('\r'));
    setStatus(pid, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(session.state).toBe('busy');
    await session.handleHook('Stop', { last_assistant_message: 'ok' });
    await expect(answer).resolves.toMatchObject({ answer: 'ok' });
  });
});
