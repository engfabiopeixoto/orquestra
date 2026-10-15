import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRolloutWatcher, type CodexRolloutEvent } from '../src/codex-rollout-watcher.js';
import { silentLogger, type Logger } from '../src/log.js';
import { waitFor } from './helpers/wait.js';

const realFixture = fileURLToPath(new URL('./fixtures/codex-rollouts/codex-0.162.1-validation.jsonl', import.meta.url));
const fixtureText = readFileSync(realFixture, 'utf8');
const sessionId = '01a13c79-4f85-7370-ad90-465dfe4378d7';
const cwd = 'C:\\Users\\USER\\AppData\\Local\\Temp\\orq-val-039\\proj-val-a';
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-rollout-watch-'));
  tempDirs.push(home);
  return home;
}

function rolloutPath(home: string, id: string): string {
  const now = new Date();
  const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  return join(day, `rollout-${stamp}-${id}.jsonl`);
}

function event(type: string, turnId: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId, ...extra } })}\n`;
}

function newThreadRollout(home: string, id: string): string {
  const path = rolloutPath(home, id);
  writeFileSync(path, [
    { type: 'session_meta', payload: { id, cwd, cli_version: '0.162.1' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

describe('CodexRolloutWatcher', () => {
  it('descobre a thread sem hooks pelo cwd e nome no rollout real 0.162.1', async () => {
    const home = makeHome();
    const path = rolloutPath(home, sessionId);
    writeFileSync(path, fixtureText);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await waitFor(() => events.some((item) => item.kind === 'turn-aborted') && events.some((item) => item.kind === 'task-complete' && item.answer === 'DELTAK2'));
      expect(events[0]).toEqual({ kind: 'session', sessionId });
      expect(events).toContainEqual({ kind: 'task-started', sessionId, turnId: '01a13c7a-0ded-7ea3-86e2-6368dacc85f1' });
      expect(events).toContainEqual({ kind: 'task-complete', sessionId, turnId: '01a13c7a-0ded-7ea3-86e2-6368dacc85f1', answer: 'PRONTO' });
      expect(events).toContainEqual({ kind: 'turn-aborted', sessionId, turnId: '01a13c86-3f08-78d1-825a-d8978aa12c61', reason: 'interrupted' });
      expect(events).toContainEqual({ kind: 'task-complete', sessionId, turnId: '01a13c86-6234-73a0-8c70-74656bba8b8d', answer: 'DELTAK2' });
    } finally {
      await watcher.stop();
    }
  });

  it('acompanha por offset e não toma texto de resposta ou rodapé como task_complete', async () => {
    const home = makeHome();
    const path = rolloutPath(home, sessionId);
    copyFileSync(realFixture, path);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', sessionId, startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await waitFor(() => events.some((item) => item.kind === 'session'));
      const turnId = 'turn-long-1';
      appendFileSync(path, event('task_started', turnId));
      await waitFor(() => events.some((item) => item.kind === 'task-started' && item.turnId === turnId));
      appendFileSync(path, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Worked for 2s • 05:54 task_complete — ainda estou trabalhando.' }] } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events.some((item) => item.kind === 'task-complete' && item.turnId === turnId)).toBe(false);
      appendFileSync(path, event('task_complete', turnId, { last_agent_message: 'resposta longa final' }));
      await waitFor(() => events.some((item) => item.kind === 'task-complete' && item.turnId === turnId));
      expect(events).toContainEqual({ kind: 'task-complete', sessionId, turnId, answer: 'resposta longa final' });
    } finally {
      await watcher.stop();
    }
  });

  it('separa duas threads sem hooks no mesmo cwd pelo nome do terminal', async () => {
    const home = makeHome();
    const yPath = rolloutPath(home, sessionId);
    writeFileSync(yPath, fixtureText);
    const xId = 'thread-x-0123';
    const xPath = rolloutPath(home, xId);
    writeFileSync(xPath, fixtureText.replaceAll(sessionId, xId).replaceAll('Seu terminal se chama Y.', 'Seu terminal se chama X.'));
    const eventsX: CodexRolloutEvent[] = [];
    const eventsY: CodexRolloutEvent[] = [];
    const options = { codexHome: home, cwd, startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger() };
    const watcherX = new CodexRolloutWatcher({ ...options, terminalName: 'X', onEvent: (item) => eventsX.push(item) });
    const watcherY = new CodexRolloutWatcher({ ...options, terminalName: 'Y', onEvent: (item) => eventsY.push(item) });
    watcherX.start();
    watcherY.start();
    try {
      await waitFor(() => eventsX.some((item) => item.kind === 'session') && eventsY.some((item) => item.kind === 'session'));
      expect(eventsX.find((item) => item.kind === 'session')).toEqual({ kind: 'session', sessionId: xId });
      expect(eventsY.find((item) => item.kind === 'session')).toEqual({ kind: 'session', sessionId });
      expect(eventsX.every((item) => item.sessionId === xId)).toBe(true);
      expect(eventsY.every((item) => item.sessionId === sessionId)).toBe(true);
    } finally {
      await Promise.all([watcherX.stop(), watcherY.stop()]);
    }
  });

  it('troca para o rollout criado por /new e passa a acompanhar os eventos da thread nova', async () => {
    const home = makeHome();
    const oldPath = rolloutPath(home, sessionId);
    writeFileSync(oldPath, fixtureText);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === sessionId));
      const newSessionId = 'thread-after-new-0123';
      const newPath = newThreadRollout(home, newSessionId);
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === newSessionId), 5000);
      appendFileSync(newPath, event('task_started', 'new-turn-1'));
      await waitFor(() => events.some((item) => item.kind === 'task-started' && item.sessionId === newSessionId && item.turnId === 'new-turn-1'));
      appendFileSync(newPath, event('task_complete', 'new-turn-1', { last_agent_message: 'resposta depois de /new' }));
      await waitFor(() => events.some((item) => item.kind === 'task-complete' && item.sessionId === newSessionId));
      appendFileSync(oldPath, event('task_started', 'must-not-be-read'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.some((item) => 'turnId' in item && item.turnId === 'must-not-be-read')).toBe(false);
    } finally {
      await watcher.stop();
    }
  });

  it('usa backoff ao procurar um id ausente e encontra o rollout quando ele aparece', async () => {
    const home = makeHome();
    const search = vi.fn();
    const log = { trace() {}, debug: search, info() {}, warn() {}, error() {} } as unknown as Logger;
    const events: CodexRolloutEvent[] = [];
    const lateSessionId = 'thread-created-later-0123';
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', sessionId: lateSessionId, pollMs: 10, log, onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(search.mock.calls.length).toBeLessThanOrEqual(2);
      const path = rolloutPath(home, lateSessionId);
      writeFileSync(path, fixtureText.replaceAll(sessionId, lateSessionId));
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === lateSessionId));
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionId: lateSessionId }), 'buscando rollout Codex pelo id');
    } finally {
      await watcher.stop();
    }
  });
});
