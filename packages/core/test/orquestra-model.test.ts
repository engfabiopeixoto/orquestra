import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/types.js';
import { claudeProjectDirName } from '../src/agent-model.js';
import { silentLogger } from '../src/log.js';
import { createOrquestra, type Orquestra, type OrquestraEvent } from '../src/orquestra.js';
import { createFakeAdapter } from './helpers/fake-adapter.js';
import { FakePtyHost } from './helpers/fake-pty-host.js';
import { waitFor } from './helpers/wait.js';

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/models/${path}`, import.meta.url));

/** Adapter falso com o tipo de um agente real: passa --model como o agy e informa modelName no Stop. */
function modelAdapter(kind: 'agy' | 'claude', agentSessionId?: string): AgentAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    kind,
    launch: (ctx) => ({ ...fake.launch(ctx), args: ['agente', ...(ctx.model ? ['--model', ctx.model] : [])], ...(agentSessionId ? { agentSessionId } : {}) }),
    interpretHook: (event, payload) => {
      const data = payload as { modelName?: string; last_assistant_message?: string };
      if (event !== 'Stop') return { kind: 'ignored' };
      return { kind: 'turn-end', text: data.last_assistant_message ?? null, transcriptPath: null, agentSessionId: null, ...(data.modelName ? { model: data.modelName } : {}) };
    },
  };
}

let orquestra: Orquestra | undefined;
afterEach(async () => {
  await orquestra?.close();
  orquestra = undefined;
});

async function setup(adapters: Record<string, AgentAdapter>, claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'))) {
  const host = new FakePtyHost();
  const events: OrquestraEvent[] = [];
  orquestra = await createOrquestra({
    pipePath: `\\\\.\\pipe\\orq-model-${randomBytes(4).toString('hex')}`,
    dataDir: mkdtempSync(join(tmpdir(), 'orq-unit-')),
    claudeDir,
    cliScript: 'C:/orq/bin/orq.mjs',
    adapters,
    log: silentLogger(),
    ptyHost: host,
    readyQuietMs: 20,
    typingGuardMs: 0,
    modelReadDelayMs: 10,
    listPipes: () => [],
    onEvent: (event) => events.push(event),
  });
  return { orq: orquestra, host, events };
}

const modelEvents = (events: OrquestraEvent[]) => events.flatMap((event) => (event.type === 'model' ? [event.model] : []));

describe('modelo do terminal', () => {
  it('trocar o modelo digita /model <nome> e Enter no agente, sem reiniciar, e guarda a escolha', async () => {
    const { orq, host, events } = await setup({ agy: modelAdapter('agy') });
    const session = orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir() });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    await orq.setModel('A', 'gemini-3.8-flash-low');
    expect(host.spawned).toHaveLength(1);
    expect(host.last().written.slice(-2)).toEqual(['/model gemini-3.8-flash-low', '\r']);
    expect(orq.describeTerminals()[0]).toMatchObject({ model: 'gemini-3.8-flash-low' });
    expect(modelEvents(events).at(-1)).toEqual({ chosen: 'gemini-3.8-flash-low', effective: null, status: 'unknown' });
  });

  it('o modelo escolhido vai na flag do CLI ao reiniciar e ao restaurar', async () => {
    const { orq, host } = await setup({ agy: modelAdapter('agy') });
    const session = orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir(), model: 'gemini-4-argon-high' });
    expect(host.spawned.at(-1)!.spec.args).toEqual(expect.arrayContaining(['--model', 'gemini-4-argon-high']));
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    await orq.setModel('A', 'gemini-3.8-flash-low');
    await orq.restartTerminal('A');
    expect(host.spawned.at(-1)!.spec.args).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash-low']));
    expect(orq.modelOf('A')).toMatchObject({ chosen: 'gemini-3.8-flash-low' });
  });

  it('recusa trocar com o agente ocupado ou com texto na caixa de entrada', async () => {
    const { orq, host } = await setup({ agy: modelAdapter('agy') });
    const session = orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir() });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    session.userInput('rascunho');
    await expect(orq.setModel('A', 'gemini-3.8-flash-low')).rejects.toThrow(/caixa de entrada/);
    session.userInput('\r');
    expect(session.state).toBe('busy');
    await expect(orq.setModel('A', 'gemini-3.8-flash-low')).rejects.toThrow(/não está ocioso/);
    expect(host.last().written).not.toContain('/model gemini-3.8-flash-low');
    expect(orq.describeTerminals()[0]?.model).toBeUndefined();
  });

  it('terminal descarregado só guarda a escolha; shell e nome inválido são recusados', async () => {
    const { orq, host } = await setup({ agy: modelAdapter('agy'), shell: createFakeAdapter() });
    orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir(), unloaded: true });
    await orq.setModel('A', 'gemini-3.8-flash-low');
    expect(orq.describeTerminals()[0]).toMatchObject({ model: 'gemini-3.8-flash-low', unloaded: true });
    orq.createTerminal({ name: 'S', agent: 'shell', cwd: tmpdir() });
    await expect(orq.setModel('S', 'opus')).rejects.toThrow(/shell não tem modelo/);
    expect(orq.modelOf('S')).toBeNull();
    await expect(orq.setModel('A', 'opus; rm')).rejects.toThrow(/Modelo inválido/);
    expect(() => orq.createTerminal({ name: 'B', agent: 'agy', cwd: tmpdir(), model: 'com espaço' })).toThrow(/Modelo inválido/);
    expect(host.spawned).toHaveLength(1);
  });

  it('agy: o modelName do Stop confirma o modelo ou acende o alerta', async () => {
    const { orq, host, events } = await setup({ agy: modelAdapter('agy') });
    const session = orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir(), model: 'gemini-3.8-flash-high' });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    session.userInput('oi\r');
    await session.handleHook('Stop', { modelName: 'gemini-3.8-flash-high' });
    expect(orq.modelOf('A')).toEqual({ chosen: 'gemini-3.8-flash-high', effective: 'gemini-3.8-flash-high', status: 'match' });
    session.userInput('de novo\r');
    await session.handleHook('Stop', { modelName: 'gemini-3.8-flash-low' });
    expect(modelEvents(events).at(-1)).toEqual({ chosen: 'gemini-3.8-flash-high', effective: 'gemini-3.8-flash-low', status: 'mismatch' });
  });

  it('claude: lê o modelo da última resposta na transcrição quando o turno acaba', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    const cwd = mkdtempSync(join(tmpdir(), 'orq-cwd-'));
    const id = '11111111-1111-4111-8111-111111111111';
    const { orq, host, events } = await setup({ claude: modelAdapter('claude', id) }, claudeDir);
    // Transcrição de antes do lançamento: mostra o modelo, mas não serve para confirmar a escolha atual.
    const projectDir = join(claudeDir, 'projects', claudeProjectDirName(cwd));
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, `${id}.jsonl`);
    copyFileSync(fixture('claude-session.jsonl'), transcript);
    const session = orq.createTerminal({ name: 'A', agent: 'claude', cwd, model: 'opus' });
    await waitFor(() => modelEvents(events).length > 0);
    expect(orq.modelOf('A')).toEqual({ chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'pending' });
    const answer = (model: string) => `${JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] } })}\n`;
    writeFileSync(transcript, answer('claude-sonnet-5-5'), { flag: 'a' });
    host.last().emitData('pronto> ');
    await waitFor(() => orq.modelOf('A')?.status === 'mismatch');
    expect(orq.modelOf('A')).toEqual({ chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'mismatch' });
    session.userInput('oi\r');
    writeFileSync(transcript, answer('claude-opus-5-5'), { flag: 'a' });
    await session.handleHook('Stop', { last_assistant_message: 'ok' });
    await waitFor(() => orq.modelOf('A')?.status === 'match');
    expect(orq.modelOf('A')?.effective).toBe('claude-opus-5-5');
  });

  it('sem modelo escolhido, mostra o modelo efetivo sem alerta', async () => {
    const { orq, host } = await setup({ agy: modelAdapter('agy') });
    const session = orq.createTerminal({ name: 'A', agent: 'agy', cwd: tmpdir() });
    host.last().emitData('pronto> ');
    await waitFor(() => session.state === 'idle');
    session.userInput('oi\r');
    await session.handleHook('Stop', { modelName: 'gemini-3.8-flash-medium' });
    expect(orq.modelOf('A')).toEqual({ chosen: null, effective: 'gemini-3.8-flash-medium', status: 'unset' });
  });
});
