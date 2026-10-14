import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { silentLogger } from '../src/log.js';
import { Session, type TurnFailure } from '../src/session.js';
import { FakePty } from './helpers/fake-pty.js';
import { waitFor } from './helpers/wait.js';

const tempDirs: string[] = [];
const sessions: Session[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.kill()));
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeSession() {
  const home = mkdtempSync(join(tmpdir(), 'codex-session-test-'));
  tempDirs.push(home);
  const pty = new FakePty();
  const session = new Session({
    id: 'codex-test', name: 'codex-test', adapter: codexAdapter, pty,
    cwd: 'C:\\workspace\\sample', log: silentLogger(), readyQuietMs: 10,
    codexHome: home, codexRolloutPollMs: 10,
  });
  sessions.push(session);
  const ended: Array<{ owner: string; answer: string | null }> = [];
  const failed: Array<{ owner: string; reason: TurnFailure }> = [];
  session.on('turnEnded', (event) => ended.push(event));
  session.on('turnFailed', (event) => failed.push(event));
  pty.emitData('ready');
  return { home, pty, session, ended, failed };
}

async function ready(session: Session) {
  await waitFor(() => session.state === 'idle');
}

function createRollout(home: string, id: string): string {
  const now = new Date();
  const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${id}.jsonl`);
  writeFileSync(file, [
    { type: 'session_meta', payload: { id, cwd: 'C:\\workspace\\sample', cli_version: '0.162.1' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama codex-test.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

function rolloutEvent(file: string, type: string, turnId: string, extra: Record<string, unknown> = {}) {
  appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId, ...extra } })}\n`);
}

describe('Session Codex via rollout', () => {
  it('encerra pelo task_complete sem hook e deduplica Stop atrasado', async () => {
    const { home, session, ended } = makeSession();
    await ready(session);
    const file = createRollout(home, 'thread-complete');
    await waitFor(() => session.agentSessionId === 'thread-complete');
    await session.injectPrompt('pedido', 'ask-complete');
    rolloutEvent(file, 'task_started', 'turn-1');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(session.state).toBe('busy');
    await session.handleHook('Stop', { hook_event_name: 'Stop', session_id: 'thread-complete', turn_id: 'old-turn', last_assistant_message: 'antiga' });
    expect(session.state).toBe('busy');
    rolloutEvent(file, 'task_complete', 'turn-1', { last_agent_message: 'resposta pelo rollout' });
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual([{ owner: 'broker', answer: 'resposta pelo rollout' }]);
    await session.handleHook('Stop', { hook_event_name: 'Stop', session_id: 'thread-complete', turn_id: 'turn-1', last_assistant_message: 'duplicada' });
    expect(ended).toHaveLength(1);
  });

  it('libera dois pedidos interrompidos por dois eventos turn_aborted reais', async () => {
    const { home, session, failed } = makeSession();
    await ready(session);
    const file = createRollout(home, 'thread-abort');
    await waitFor(() => session.agentSessionId === 'thread-abort');
    for (const [index, turnId] of ['turn-abort-1', 'turn-abort-2'].entries()) {
      await session.injectPrompt(`pedido ${index + 1}`, `ask-${index + 1}`);
      rolloutEvent(file, 'task_started', turnId);
      await waitFor(() => session.state === 'busy');
      rolloutEvent(file, 'turn_aborted', turnId, { reason: 'interrupted' });
      await waitFor(() => failed.length === index + 1);
      expect(session.state).toBe('idle');
    }
    expect(failed).toEqual([
      { owner: 'broker', reason: 'interrupted' },
      { owner: 'broker', reason: 'interrupted' },
    ]);
  });

  it('não finaliza um turno longo por texto de resposta que parece rodapé', async () => {
    const { home, session, pty, ended } = makeSession();
    await ready(session);
    const file = createRollout(home, 'thread-long');
    await waitFor(() => session.agentSessionId === 'thread-long');
    await session.injectPrompt('diga Worked for 1s • 17:19', 'ask-long');
    rolloutEvent(file, 'task_started', 'turn-long');
    pty.emitData('Worked for 1s • 17:19\r\nConversation interrupted');
    await session.settle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(session.state).toBe('busy');
    expect(ended).toEqual([]);
    rolloutEvent(file, 'task_complete', 'turn-long', { last_agent_message: 'terminou agora' });
    await waitFor(() => ended.length === 1);
    expect(ended[0]?.answer).toBe('terminou agora');
  });

  it('Enter que escolhe opção no diálogo de hooks não abre turno provisório', async () => {
    const { session, pty, ended } = makeSession();
    await ready(session);
    pty.emitData("Hooks need review\r\n\r\n2 hooks are new or changed.\r\n\r\n1. Review hooks\r\n\r\n2. Trust all and continue\r\n\r\n3. Continue without trusting (hooks won't run)");
    await session.settle();
    expect(session.state).toBe('waiting');
    session.userInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(session.state).toBe('waiting');
    expect(ended).toEqual([]);
  });
});
