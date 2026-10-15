import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexRolloutMatchesTerminal, CodexRolloutWatcher, type CodexRolloutEvent } from '../src/codex-rollout-watcher.js';
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

function newThreadRollout(home: string, id: string, timestamp: string, options: { cwd?: string; terminalName?: string; terminalId?: string } = {}): string {
  const path = rolloutPath(home, id);
  const terminalName = options.terminalName ?? 'Y';
  const terminalId = options.terminalId ?? 'terminal-y';
  writeFileSync(path, [
    { type: 'session_meta', timestamp, payload: { id, cwd: options.cwd ?? cwd, timestamp, cli_version: '0.162.1' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `Seu terminal se chama ${terminalName}. Identificador do terminal no Orquestra: ${terminalId}.` }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

describe('CodexRolloutWatcher', () => {
  it('descobre a thread sem hooks pelo cwd e nome no rollout real 0.162.1', async () => {
    const home = makeHome();
    const path = rolloutPath(home, sessionId);
    writeFileSync(path, `${fixtureText}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
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
    appendFileSync(path, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', sessionId, startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
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
    writeFileSync(yPath, `${fixtureText}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
    const xId = 'thread-x-0123';
    const xPath = rolloutPath(home, xId);
    writeFileSync(xPath, `${fixtureText.replaceAll(sessionId, xId)}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama X. Identificador do terminal no Orquestra: terminal-x.' }] } })}\n`);
    const eventsX: CodexRolloutEvent[] = [];
    const eventsY: CodexRolloutEvent[] = [];
    const options = { codexHome: home, cwd, startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger() };
    const watcherX = new CodexRolloutWatcher({ ...options, terminalName: 'X', terminalId: 'terminal-x', onEvent: (item) => eventsX.push(item) });
    const watcherY = new CodexRolloutWatcher({ ...options, terminalName: 'Y', terminalId: 'terminal-y', onEvent: (item) => eventsY.push(item) });
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
    writeFileSync(oldPath, `${fixtureText}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', startedAt: Date.now() - 10_000, pollMs: 10, log: silentLogger(), onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === sessionId));
      const newSessionId = 'thread-after-new-0123';
      const newPath = newThreadRollout(home, newSessionId, '2026-10-14T22:13:25.000Z');
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

  it('mantém a thread mais nova estável e só avança quando aparece uma terceira mais nova', async () => {
    const home = makeHome();
    const oldId = 'thread-old-001';
    const oldPath = rolloutPath(home, oldId);
    writeFileSync(oldPath, `${fixtureText.replaceAll(sessionId, oldId)}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', sessionId: oldId, startedAt: Date.now() - 10_000,
      pollMs: 5, discoveryMs: 20, log: silentLogger(), onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === oldId));
      const newId = 'thread-newest-002';
      newThreadRollout(home, newId, '2026-10-14T22:13:25.000Z');
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === newId));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(events.filter((item) => item.kind === 'session').map((item) => item.sessionId)).toEqual([oldId, newId]);

      newThreadRollout(home, 'thread-equal-timestamp-002', '2026-10-14T22:13:25.000Z');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(events.filter((item) => item.kind === 'session').map((item) => item.sessionId)).toEqual([oldId, newId]);

      appendFileSync(oldPath, event('task_started', 'must-stay-old'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events.some((item) => item.kind === 'task-started' && item.turnId === 'must-stay-old')).toBe(false);

      const thirdId = 'thread-newest-003';
      newThreadRollout(home, thirdId, '2026-10-14T22:14:25.000Z');
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === thirdId));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(events.filter((item) => item.kind === 'session').map((item) => item.sessionId)).toEqual([oldId, newId, thirdId]);
    } finally {
      await watcher.stop();
    }
  });

  it('isola rollouts por cwd e id estável mesmo com nomes iguais e promoções intercaladas', async () => {
    const home = makeHome();
    const cwdA = 'C:\\workspace\\error_detector';
    const cwdB = 'E:\\AI PROJETOS\\ACEbim';
    const idA = 'codex-terminal-error';
    const idB = 'codex-terminal-acebim';
    const idC = 'codex-terminal-same-cwd';
    newThreadRollout(home, 'thread-a1', '2026-10-15T00:00:01.000Z', { cwd: cwdA, terminalName: 'codex-1', terminalId: idA });
    newThreadRollout(home, 'thread-b1', '2026-10-15T00:00:03.000Z', { cwd: cwdB, terminalName: 'codex-1', terminalId: idB });
    newThreadRollout(home, 'thread-c1', '2026-10-15T00:00:04.000Z', { cwd: cwdA, terminalName: 'codex-1', terminalId: idC });
    const eventsA: CodexRolloutEvent[] = [];
    const eventsB: CodexRolloutEvent[] = [];
    const eventsC: CodexRolloutEvent[] = [];
    const shared = { codexHome: home, terminalName: 'codex-1', startedAt: Date.now() - 10_000, pollMs: 5, discoveryMs: 15, log: silentLogger() };
    const watcherA = new CodexRolloutWatcher({ ...shared, cwd: cwdA, terminalId: idA, onEvent: (item) => eventsA.push(item) });
    const watcherB = new CodexRolloutWatcher({ ...shared, cwd: cwdB, terminalId: idB, onEvent: (item) => eventsB.push(item) });
    const watcherC = new CodexRolloutWatcher({ ...shared, cwd: cwdA, terminalId: idC, onEvent: (item) => eventsC.push(item) });
    watcherA.start();
    watcherB.start();
    watcherC.start();
    try {
      await waitFor(() => eventsA.some((event) => event.kind === 'session') && eventsB.some((event) => event.kind === 'session') && eventsC.some((event) => event.kind === 'session'));
      expect(eventsA.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-a1']);
      expect(eventsB.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-b1']);
      expect(eventsC.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-c1']);

      const b2 = newThreadRollout(home, 'thread-b2-newest-foreign', '2026-10-15T00:00:05.000Z', { cwd: cwdB, terminalName: 'codex-1', terminalId: idB });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventsA.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-a1']);
      const a2 = newThreadRollout(home, 'thread-a2', '2026-10-15T00:00:06.000Z', { cwd: cwdA, terminalName: 'codex-1', terminalId: idA });
      await waitFor(() => eventsA.some((event) => event.kind === 'session' && event.sessionId === 'thread-a2'));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventsA.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-a1', 'thread-a2']);
      expect(eventsB.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-b1', 'thread-b2-newest-foreign']);
      expect(eventsC.filter((event) => event.kind === 'session').map((event) => event.sessionId)).toEqual(['thread-c1']);
      appendFileSync(b2, event('task_started', 'must-not-cross-workspace'));
      appendFileSync(a2, event('task_started', 'belongs-to-a2'));
      await waitFor(() => eventsA.some((item) => item.kind === 'task-started' && item.turnId === 'belongs-to-a2'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(eventsA.some((item) => item.kind === 'task-started' && item.turnId === 'must-not-cross-workspace')).toBe(false);
      expect(eventsB.some((item) => item.kind === 'task-started' && item.turnId === 'must-not-cross-workspace')).toBe(true);
    } finally {
      await Promise.all([watcherA.stop(), watcherB.stop(), watcherC.stop()]);
    }
  });

  it('não associa pelo id conhecido se o cwd do rollout pertence a outro workspace', async () => {
    const home = makeHome();
    const foreignPath = newThreadRollout(home, 'known-foreign-id', '2026-10-15T00:00:01.000Z', { cwd: 'E:\\foreign-workspace', terminalName: 'codex-1', terminalId: 'foreign-terminal' });
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({ codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', sessionId: 'known-foreign-id', startedAt: Date.now() - 10_000, pollMs: 5, log: silentLogger(), onEvent: (item) => events.push(item) });
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(events).toEqual([]);
      expect(foreignPath).toContain('known-foreign-id');
      expect(codexRolloutMatchesTerminal('known-foreign-id', cwd, 'terminal-y', home)).toBe(false);
      expect(codexRolloutMatchesTerminal('known-foreign-id', 'E:\\foreign-workspace', 'foreign-terminal', home)).toBe(true);
    } finally {
      await watcher.stop();
    }
  });

  it('não associa um id conhecido do mesmo cwd quando o id estável é de outro terminal', async () => {
    const home = makeHome();
    newThreadRollout(home, 'known-same-cwd-id', '2026-10-15T00:00:01.000Z', { cwd, terminalName: 'Y', terminalId: 'terminal-other' });
    const events: CodexRolloutEvent[] = [];
    const watcher = new CodexRolloutWatcher({ codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', sessionId: 'known-same-cwd-id', startedAt: Date.now() - 10_000, pollMs: 5, log: silentLogger(), onEvent: (item) => events.push(item) });
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toEqual([]);
      expect(codexRolloutMatchesTerminal('known-same-cwd-id', cwd, 'terminal-y', home)).toBe(false);
    } finally {
      await watcher.stop();
    }
  });

  it('mantém o resume manual de um rollout legado sem id terminal quando o cwd confere', async () => {
    const home = makeHome();
    const path = rolloutPath(home, 'legacy-thread');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'legacy-thread', cwd, timestamp: '2026-10-15T00:00:01.000Z' } })}\n`);
    expect(codexRolloutMatchesTerminal('legacy-thread', cwd, 'terminal-y', home)).toBe(true);
  });

  it('usa backoff ao procurar um id ausente e encontra o rollout quando ele aparece', async () => {
    const home = makeHome();
    const search = vi.fn();
    const log = { trace() {}, debug: search, info() {}, warn() {}, error() {} } as unknown as Logger;
    const events: CodexRolloutEvent[] = [];
    const lateSessionId = 'thread-created-later-0123';
    const watcher = new CodexRolloutWatcher({
      codexHome: home, cwd, terminalName: 'Y', terminalId: 'terminal-y', sessionId: lateSessionId, pollMs: 10, log, onEvent: (item) => events.push(item),
    });
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(search.mock.calls.length).toBeLessThanOrEqual(2);
      const path = rolloutPath(home, lateSessionId);
      writeFileSync(path, `${fixtureText.replaceAll(sessionId, lateSessionId)}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Seu terminal se chama Y. Identificador do terminal no Orquestra: terminal-y.' }] } })}\n`);
      await waitFor(() => events.some((item) => item.kind === 'session' && item.sessionId === lateSessionId));
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionId: lateSessionId }), 'buscando rollout Codex pelo id');
    } finally {
      await watcher.stop();
    }
  });
});
