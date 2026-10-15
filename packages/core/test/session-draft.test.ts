import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/types.js';
import { silentLogger } from '../src/log.js';
import { Session, type TurnFailure, type TurnOwner } from '../src/session.js';
import { FakePty } from './helpers/fake-pty.js';
import { waitFor } from './helpers/wait.js';

const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const BACKSPACE = String.fromCharCode(127);

const adapter: AgentAdapter = {
  kind: 'claude',
  acceptsPrompts: true,
  screenRules: [],
  launch: () => ({ command: 'x', args: [], env: {} }),
  interpretHook: (event, payload) => {
    const p = payload as { text?: string | null };
    if (event === 'Stop') return { kind: 'turn-end', text: p.text ?? null, transcriptPath: null, agentSessionId: 's' };
    return { kind: 'ignored' };
  },
  preparePrompt: (text) => text,
};

async function setup() {
  const pty = new FakePty();
  const session = new Session({ id: 'id1', name: 'W', adapter, pty, cwd: '.', log: silentLogger(), readyQuietMs: 20, idleGraceMs: 30 });
  const failed: Array<{ owner: TurnOwner; reason: TurnFailure }> = [];
  const drafts: boolean[] = [];
  session.on('turnFailed', (event) => failed.push(event));
  session.on('draft', (pending) => drafts.push(pending));
  pty.emitData('pronto> ');
  await waitFor(() => session.state === 'idle');
  return { pty, session, failed, drafts };
}

/** O usuário envia um pedido e o agente fica ocioso sem fim de turno (Esc antes do primeiro token). */
async function interruptedUserTurn(text = 'meu rascunho') {
  const env = await setup();
  env.session.userInput(text);
  env.session.userInput(CR);
  expect(env.session.state).toBe('busy');
  env.session.agentIdle();
  await waitFor(() => env.failed.length === 1);
  return env;
}

describe('rascunho devolvido pelo agente depois de um turno do usuário interrompido', () => {
  it('marca a caixa como tendo rascunho, antes de liberar o terminal', async () => {
    const { session, failed, drafts } = await interruptedUserTurn();
    expect(failed).toEqual([{ owner: 'user', reason: 'interrupted' }]);
    expect(session.state).toBe('idle');
    expect(session.hasDraft).toBe(true);
    expect(drafts).toEqual([true]);
  });

  it('turno do broker interrompido não deixa rascunho', async () => {
    const { session, failed } = await setup();
    await session.injectPrompt('pedido', 'ask-1');
    session.agentIdle();
    await waitFor(() => failed.length === 1);
    expect(failed[0]).toEqual({ owner: 'broker', reason: 'interrupted' });
    expect(session.hasDraft).toBe(false);
  });

  it('turno do usuário sem texto (Enter vazio) não deixa rascunho', async () => {
    const { session, failed } = await setup();
    session.userInput(CR);
    session.agentIdle();
    await waitFor(() => failed.length === 1);
    expect(session.hasDraft).toBe(false);
  });

  it('Ctrl+C e Ctrl+U do usuário limpam o rascunho', async () => {
    for (const key of [CTRL_C, CTRL_U]) {
      const { session, drafts } = await interruptedUserTurn();
      session.userInput(key);
      expect(session.hasDraft).toBe(false);
      expect(drafts).toEqual([true, false]);
    }
  });

  it('o Enter do usuário envia o rascunho: abre o turno dele como pedido de verdade e limpa a marca', async () => {
    const { session, drafts } = await interruptedUserTurn();
    session.userInput(CR);
    expect(session.hasDraft).toBe(false);
    expect(session.state).toBe('busy');
    expect(drafts).toEqual([true, false]);
    // Com o rascunho marcado como texto, o turno não é provisório: não volta a idle por silêncio.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.state).toBe('busy');
  });

  it('apagar todos os caracteres com Backspace limpa o rascunho; apagar parte, não', async () => {
    const { session } = await interruptedUserTurn('abc');
    session.userInput(BACKSPACE);
    session.userInput(BACKSPACE);
    expect(session.hasDraft).toBe(true);
    session.userInput(BACKSPACE);
    expect(session.hasDraft).toBe(false);
  });

  it('digitar mais no rascunho aumenta o que precisa ser apagado', async () => {
    const { session } = await interruptedUserTurn('ab');
    session.userInput('c');
    session.userInput(BACKSPACE);
    session.userInput(BACKSPACE);
    expect(session.hasDraft).toBe(true);
    session.userInput(BACKSPACE);
    expect(session.hasDraft).toBe(false);
  });

  it('o fim normal do turno do usuário (Stop) não deixa rascunho', async () => {
    const { session } = await setup();
    session.userInput('pedido');
    session.userInput(CR);
    await session.handleHook('Stop', { text: 'resposta' });
    expect(session.hasDraft).toBe(false);
  });
});
