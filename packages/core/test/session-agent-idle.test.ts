import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/types.js';
import { silentLogger } from '../src/log.js';
import { Session, type TurnFailure, type TurnOwner } from '../src/session.js';
import { FakePty } from './helpers/fake-pty.js';
import { waitFor } from './helpers/wait.js';

const adapter: AgentAdapter = {
  kind: 'claude',
  acceptsPrompts: true,
  screenRules: [],
  launch: () => ({ command: 'x', args: [], env: {} }),
  interpretHook: (event, payload) => {
    const p = payload as { text?: string | null };
    if (event === 'Stop') return { kind: 'turn-end', text: p.text ?? null, transcriptPath: null, agentSessionId: 's' };
    if (event === 'PostToolUse') return { kind: 'activity' };
    return { kind: 'ignored' };
  },
  preparePrompt: (text) => text,
};

async function setup(idleGraceMs = 60) {
  const pty = new FakePty();
  const session = new Session({ id: 'id1', name: 'W', adapter, pty, cwd: '.', log: silentLogger(), readyQuietMs: 20, idleGraceMs });
  const ended: Array<{ owner: TurnOwner; answer: string | null }> = [];
  const failed: Array<{ owner: TurnOwner; reason: TurnFailure }> = [];
  session.on('turnEnded', (event) => ended.push(event));
  session.on('turnFailed', (event) => failed.push(event));
  pty.emitData('pronto> ');
  await waitFor(() => session.state === 'idle');
  return { pty, session, ended, failed };
}

describe('Session.agentIdle (agente ocioso sem hook de fim de turno)', () => {
  it('turno do broker vira interrompido depois da tolerância e o terminal volta a idle', async () => {
    const { session, failed } = await setup();
    await session.injectPrompt('pedido', 'ask-1');
    expect(session.state).toBe('busy');
    session.agentIdle();
    await waitFor(() => failed.length === 1);
    expect(failed).toEqual([{ owner: 'broker', reason: 'interrupted' }]);
    expect(session.state).toBe('idle');
  });

  it('avisa quem chamou, com o dono do turno, antes de falhar e liberar a fila', async () => {
    const { session, failed } = await setup();
    await session.injectPrompt('pedido', 'ask-1');
    const order: string[] = [];
    session.on('turnFailed', () => order.push('turnFailed'));
    session.agentIdle((owner) => order.push(`expirou:${owner}:${session.state}`));
    await waitFor(() => failed.length === 1);
    expect(order).toEqual(['expirou:broker:busy', 'turnFailed']);
  });

  it('sendControl escreve no terminal sem contar como digitação do usuário', async () => {
    const { pty, session } = await setup();
    const before = session.lastUserInputAt;
    session.sendControl(String.fromCharCode(3));
    expect(pty.written.at(-1)).toBe(String.fromCharCode(3));
    expect(session.lastUserInputAt).toBe(before);
  });

  it('o hook Stop dentro da tolerância conclui o turno normalmente', async () => {
    const { session, ended, failed } = await setup(200);
    await session.injectPrompt('pedido', 'ask-1');
    session.agentIdle();
    await session.handleHook('Stop', { text: 'resposta' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ended).toEqual([{ owner: 'broker', answer: 'resposta' }]);
    expect(failed).toEqual([]);
  });

  it('voltar a ocupado ou receber atividade cancela a tolerância', async () => {
    const { session, failed } = await setup(80);
    await session.injectPrompt('pedido', 'ask-1');
    session.agentIdle();
    session.agentBusy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(failed).toEqual([]);
    expect(session.state).toBe('busy');
    session.agentIdle();
    await session.handleHook('PostToolUse', {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(failed).toEqual([]);
  });

  it('sem turno em curso ou depois da saída do processo não faz nada', async () => {
    const { pty, session, failed } = await setup(40);
    session.agentIdle();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(failed).toEqual([]);
    await session.injectPrompt('pedido', 'ask-1');
    session.agentIdle();
    pty.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(failed).toEqual([{ owner: 'broker', reason: 'exited' }]);
  });
});
