import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/types.js';
import { pino } from 'pino';
import { silentLogger, type Logger } from '../src/log.js';
import { Screen } from '../src/screen.js';
import { Session, type TurnFailure, type TurnOwner } from '../src/session.js';
import { FakePty } from './helpers/fake-pty.js';
import { waitFor } from './helpers/wait.js';

function testAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    kind: 'teste',
    acceptsPrompts: true,
    screenRules: [
      { pattern: /Permitir\?/, signal: 'waiting' },
      { pattern: /Interrompido!/, signal: 'interrupted', scope: 'new-occurrence' },
      { pattern: /Falhou!/, signal: 'failed', scope: 'new-occurrence' },
    ],
    launch: () => ({ command: 'x', args: [], env: {} }),
    interpretHook: (event, payload) => {
      const p = payload as { text?: string | null; transcript?: string };
      if (event === 'Stop') return { kind: 'turn-end', text: p.text ?? null, transcriptPath: p.transcript ?? null, agentSessionId: 's' };
      if (event === 'Notification') return { kind: 'waiting', detail: 'perm' };
      return { kind: 'ignored' };
    },
    preparePrompt: (text) => text,
    ...overrides,
  };
}

function setup(adapter = testAdapter(), log: Logger = silentLogger()) {
  const pty = new FakePty();
  const session = new Session({
    id: 'id1',
    name: 'B',
    adapter,
    pty,
    cwd: '.',
    log,
    readyQuietMs: 50,
    userTurnQuietMs: 200,
    transcriptRetries: 3,
    transcriptRetryMs: 10,
  });
  const ended: Array<{ owner: TurnOwner; answer: string | null }> = [];
  const failed: Array<{ owner: TurnOwner; reason: TurnFailure }> = [];
  session.on('turnEnded', (event) => ended.push(event));
  session.on('turnFailed', (event) => failed.push(event));
  return { pty, session, ended, failed };
}

async function ready(pty: FakePty, session: Session) {
  pty.emitData('pronto> ');
  await waitFor(() => session.state === 'idle');
}

describe('Session', () => {
  it('o id da sessão do agente vem também do Stop e avisa quando muda', async () => {
    const adapter = testAdapter({
      interpretHook: () => ({ kind: 'turn-end', text: 'ok', transcriptPath: null, agentSessionId: 'conv-2' }),
    });
    const { pty, session } = setup(adapter);
    const seen: string[] = [];
    session.on('agentSession', (id) => seen.push(id));
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    await session.handleHook('Stop', {});
    await session.handleHook('Stop', {});
    expect(session.agentSessionId).toBe('conv-2');
    expect(seen).toEqual(['conv-2']);
  });

  it('o núcleo responde às consultas do terminal (o ConPTY espera a identificação antes de mostrar a saída)', async () => {
    const { pty, session } = setup();
    pty.emitData('\x1b[c');
    await session.settle();
    await waitFor(() => pty.written.includes('\x1b[?1;2c'));
    // Resposta automática não conta como digitação do usuário (não segura o broker).
    expect(session.lastUserInputAt).toBe(0);
  });

  it('retrato tirado no meio de uma sequência de escape não deixa letra sobrando na interface', async () => {
    const { pty, session } = setup();
    pty.emitData('linha 1\r\nlinha 2\x1b[1');
    await session.settle();
    const snapshot = session.snapshot();
    pty.emitData(';1Hx');
    await session.settle();
    // A interface: xterm limpo do mesmo tamanho, recebe o retrato e depois a saída ao vivo.
    const copy = new Screen(snapshot.cols, snapshot.rows);
    await copy.write(snapshot.data);
    await copy.write(';1Hx');
    expect(copy.text()).toBe(session.screenText());
    expect(copy.text()).toBe('xinha 1\nlinha 2');
  });

  it('erro do agente na tela falha o turno com agent-error', async () => {
    const { pty, session, failed } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitData('\r\nFalhou!\r\n> ');
    await waitFor(() => failed.length === 1);
    expect(failed[0]).toEqual({ owner: 'broker', reason: 'agent-error' });
    expect(session.state).toBe('idle');
  });

  it('falha ao digitar devolve a sessão a idle', async () => {
    const { pty, session } = setup();
    await ready(pty, session);
    pty.write = () => {
      throw new Error('pipe fechado');
    };
    await expect(session.injectPrompt('x', 'a1')).rejects.toThrow('pipe fechado');
    expect(session.state).toBe('idle');
  });

  it('fica idle depois de a saída silenciar', async () => {
    const { pty, session } = setup();
    expect(session.state).toBe('starting');
    await ready(pty, session);
  });

  it('diálogo na tela durante a partida segura o idle até o usuário responder', async () => {
    const { pty, session } = setup();
    pty.emitData('Permitir? ');
    await waitFor(() => session.state === 'waiting');
    pty.emitData('\x1b[2J\x1b[Hpronto> ');
    await waitFor(() => session.state === 'idle');
  });

  it('injeta o prompt, fica busy e entrega a resposta do Stop ao broker', async () => {
    const { pty, session, ended } = setup();
    await ready(pty, session);
    await session.injectPrompt('olá', 'a1');
    expect(session.state).toBe('busy');
    expect(pty.written).toEqual(['\x1b[200~olá\x1b[201~', '\r']);
    await session.handleHook('Stop', { text: 'resposta' });
    expect(ended).toEqual([{ owner: 'broker', answer: 'resposta' }]);
    expect(session.state).toBe('idle');
  });

  it('texto vazio no hook cai na transcrição, com novas tentativas', async () => {
    let calls = 0;
    const adapter = testAdapter({ readTranscript: async () => (++calls < 2 ? null : 'da transcrição') });
    const { pty, session, ended } = setup(adapter);
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    await session.handleHook('Stop', { text: '', transcript: 'C:/t.jsonl' });
    expect(ended).toEqual([{ owner: 'broker', answer: 'da transcrição' }]);
  });

  it('sem resposta em lugar nenhum, o turno falha com no-answer', async () => {
    const { pty, session, failed } = setup(testAdapter({ readTranscript: async () => null }));
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    await session.handleHook('Stop', { text: null, transcript: 'C:/t.jsonl' });
    expect(failed).toEqual([{ owner: 'broker', reason: 'no-answer' }]);
    expect(session.state).toBe('idle');
  });

  it('interrupção na tela falha o turno e volta a idle', async () => {
    const { pty, session, failed } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitData('\r\nInterrompido!\r\n> ');
    await waitFor(() => failed.length === 1);
    expect(failed[0]).toEqual({ owner: 'broker', reason: 'interrupted' });
    expect(session.state).toBe('idle');
  });

  it('permissão na tela vira waiting e volta a busy quando some', async () => {
    const { pty, session } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitData('\r\nPermitir? ');
    await waitFor(() => session.state === 'waiting');
    pty.emitData('\x1b[2J\x1b[Htrabalhando');
    await waitFor(() => session.state === 'busy');
  });

  it('Notification marca waiting até o Stop', async () => {
    const { pty, session } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    await session.handleHook('Notification', {});
    expect(session.state).toBe('waiting');
    await session.handleHook('Stop', { text: 'ok' });
    expect(session.state).toBe('idle');
  });

  it('Enter digitado pelo usuário abre um turno do usuário, sem ler resposta', async () => {
    const { pty, session, ended } = setup();
    await ready(pty, session);
    session.userInput('oi\r');
    expect(session.state).toBe('busy');
    expect(session.lastUserInputAt).toBeGreaterThan(0);
    await session.handleHook('Stop', { text: 'resposta ao usuário' });
    expect(ended).toEqual([{ owner: 'user', answer: null }]);
  });

  it('Stop sem turno em curso é ignorado', async () => {
    const { pty, session, ended } = setup();
    await ready(pty, session);
    await session.handleHook('Stop', { text: 'fantasma' });
    expect(ended).toEqual([]);
    expect(session.state).toBe('idle');
  });

  it('saída do processo no meio do turno falha o turno com exited', async () => {
    const { pty, session, failed } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitExit(1);
    expect(session.state).toBe('exited');
    expect(failed).toEqual([{ owner: 'broker', reason: 'exited' }]);
  });

  it('onOutput repassa a saída crua e o retorno remove o ouvinte', async () => {
    const { pty, session } = setup();
    const seen: string[] = [];
    const stop = session.onOutput((data) => seen.push(data));
    pty.emitData('abc');
    stop();
    pty.emitData('def');
    expect(seen).toEqual(['abc']);
  });

  it('resposta lida tarde não é atribuída ao turno seguinte', async () => {
    let release: (text: string) => void = () => {};
    const adapter = testAdapter({ readTranscript: () => new Promise<string | null>((resolve) => (release = resolve)) });
    const { pty, session, ended, failed } = setup(adapter);
    await ready(pty, session);
    await session.injectPrompt('primeiro', 'a1');
    const lateHook = session.handleHook('Stop', { text: '', transcript: 'C:/t.jsonl' });
    pty.emitData('\r\nInterrompido!\r\n> ');
    await waitFor(() => failed.length === 1);
    await session.injectPrompt('segundo', 'a2');
    release('resposta do primeiro');
    await lateHook;
    expect(ended).toEqual([]);
    expect(session.state).toBe('busy');
  });

  it('Enter do usuário que não abre turno volta a idle depois do silêncio', async () => {
    const { pty, session } = setup();
    await ready(pty, session);
    session.userInput('\r');
    expect(session.state).toBe('busy');
    await waitFor(() => session.state === 'idle', 2000);
  });

  it('turno do usuário com saída contínua não volta a idle antes do Stop', async () => {
    const { pty, session } = setup();
    await ready(pty, session);
    session.userInput('pergunta\r');
    for (let tick = 0; tick < 6; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pty.emitData('.');
    }
    expect(session.state).toBe('busy');
  });

  it('reconhece uma segunda interrupção com a primeira ainda na tela', async () => {
    const { pty, session, failed } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitData('\r\nInterrompido!\r\n> ');
    await waitFor(() => failed.length === 1);
    await session.injectPrompt('y', 'a2');
    pty.emitData('\r\nInterrompido!\r\n> ');
    await waitFor(() => failed.length === 2);
  });

  it('redesenho da tela com uma interrupção antiga não falha o turno novo', async () => {
    const { pty, session, failed } = setup();
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    pty.emitData('\r\nInterrompido!\r\n> ');
    await waitFor(() => failed.length === 1);
    await session.injectPrompt('y', 'a2');
    pty.emitData('\x1b[2J\x1b[H');
    await new Promise((resolve) => setTimeout(resolve, 50));
    pty.emitData('Interrompido!\r\n> ');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(failed).toHaveLength(1);
    expect(session.state).toBe('busy');
  });

  it('o log do hook leva o askId do turno e o payload ignorado vai inteiro', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const { pty, session } = setup(testAdapter(), log);
    await ready(pty, session);
    await session.injectPrompt('x', 'a1');
    await session.handleHook('Desconhecido', { campo: 'valor' });
    await session.handleHook('Stop', { text: 'ok' });
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'hook recebido', event: 'Stop', askId: 'a1' }));
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'hook ignorado', event: 'Desconhecido', payload: { campo: 'valor' } }));
  });

  it('erro ao escrever no terminal vai para o log', () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const { pty } = setup(testAdapter(), log);
    pty.emitError(new Error('write EAGAIN'));
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'falha ao escrever no terminal', err: expect.objectContaining({ message: 'write EAGAIN' }) }));
  });

  it('resize ajusta o PTY e a tela headless', async () => {
    const { pty, session } = setup();
    session.resize(80, 20);
    expect(pty.resizes).toEqual([[80, 20]]);
    pty.emitData('1\r\n2\r\n3\r\n'.repeat(10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.screenText().split('\n').length).toBeGreaterThan(20);
  });

  it('recusa injetar fora de idle', async () => {
    const { session } = setup();
    await expect(session.injectPrompt('x', 'a1')).rejects.toThrow(/não está ociosa/);
  });
});
