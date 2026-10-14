import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter, readCodexRolloutCompletion } from '../src/adapters/codex.js';

describe('Codex', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  it('configura hook AfterAgent via stdin, sem notify de payload em argv', () => {
    const launch = codexAdapter.launch({ ...context, hookCommand: (event) => `node "C:/Program Files/Orquestra/orq.mjs" hook codex ${event}` });
    expect(launch.args).toContain('features.hooks=true');
    expect(launch.args.some((arg) => arg.startsWith('hooks.Stop='))).toBe(true);
    expect(launch.args.some((arg) => arg.startsWith('hooks.SessionStart='))).toBe(true);
    expect(launch.args).toContain('notify=[]');
    expect(launch.args.join(' ')).not.toContain('notify=["node"');
  });
  const context = { cwd: 'C:/project', sessionDir: 'C:/session', hookCommand: (event: string) => `node "C:/Program Files/Orquestra/orq.mjs" hook codex ${event}`, resumeSessionId: null as string | null };
  it('configura o hook moderno e retoma somente a sessão associada ao terminal', () => {
    const launch = codexAdapter.launch(context);
    expect(launch.command).toBe('codex');
    expect(launch.args).toContain('features.hooks=true');
    expect(launch.args).toContain('notify=[]');
    expect(launch.args.find((arg) => arg.startsWith('hooks.Stop='))).toContain('C:/Program Files/Orquestra/orq.mjs');
    expect(launch.args.find((arg) => arg.startsWith('hooks.Stop='))).toContain('hook codex Stop');
    expect(launch.args.find((arg) => arg.startsWith('hooks.SessionStart='))).toContain('C:/Program Files/Orquestra/orq.mjs');
    expect(launch.args.find((arg) => arg.startsWith('hooks.SessionStart='))).toContain('hook codex SessionStart');
    expect(launch.args.find((arg) => arg.startsWith('mcp_servers.orquestra.args='))).toBe('mcp_servers.orquestra.args=["C:/Program Files/Orquestra/orq.mjs","mcp"]');
    expect(codexAdapter.launch({ ...context, resumeSessionId: 'thread-123' }).args.slice(0, 2)).toEqual(['resume', 'thread-123']);
    for (const resumeSessionId of [null, 'thread-123']) {
      const args = codexAdapter.launch({ ...context, terminalName: 'coordenador', regente: true, resumeSessionId }).args;
      const instructions = args.find((arg) => arg.startsWith('developer_instructions='))!;
      expect(instructions).toContain('orq whoami');
      expect(instructions).toContain('orq peers');
      expect(instructions).toContain('orq prompt');
      expect(instructions).toContain('coordenador');
      expect(instructions).toContain('regente');
      expect(args).toContain('mcp_servers.orquestra.env_vars=["ORQ_PIPE","ORQ_TOKEN"]');
      expect(args).toContain('mcp_servers.orquestra.enabled=true');
    }
  });
  it('entrega a resposta final e aprende o id para retomada', () => {
    expect(codexAdapter.interpretHook('Stop', { type: 'agent-turn-complete', 'thread-id': 'thread-123', 'last-assistant-message': 'Feito.' })).toEqual({ kind: 'turn-end', text: 'Feito.', transcriptPath: null, agentSessionId: 'thread-123' });
    expect(codexAdapter.interpretHook('Stop', { type: 'other' })).toEqual({ kind: 'ignored' });
  });

  it('interpreta o payload moderno de Stop recebido pelo hook de stdin', () => {
    expect(codexAdapter.interpretHook('Stop', {
      session_id: 'thread-123', turn_id: 'turn-2', hook_event_name: 'Stop', last_assistant_message: 'Feito pelo hook.',
    })).toEqual({ kind: 'turn-end', text: 'Feito pelo hook.', transcriptPath: null, agentSessionId: 'thread-123', completionId: 'thread-123:turn-2' });
  });

  it('aprende o thread_id no SessionStart antes do primeiro turno', () => {
    expect(codexAdapter.interpretHook('SessionStart', { session_id: 'thread-123', hook_event_name: 'SessionStart' }))
      .toEqual({ kind: 'session-start', agentSessionId: 'thread-123' });
  });

  it('lê a última resposta completa e seu turn_id do rollout pelo thread_id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    tempDirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '14');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-10-14T10-00-00-thread-123.jsonl'), [
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', thread_id: 'thread-123', turn_id: 'turn-1', message: 'intermediária' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', thread_id: 'thread-123', turn_id: 'turn-1', last_agent_message: 'resposta final' } }),
    ].join('\n'));
    await expect(readCodexRolloutCompletion('thread-123', root)).resolves.toEqual({
      completionId: 'thread-123:turn-1',
      text: 'resposta final',
    });
  });

  it('só considera rodapé completo com o recuo da TUI do Codex', () => {
    const rule = codexAdapter.screenRules.find((entry) => entry.signal === 'turn-end')!;
    expect(rule.scope).toBe('new-occurrence');
    expect(rule.pattern.test('  Worked for 2s • 05:54')).toBe(true);
    expect(rule.pattern.test('  Worked for 1s • 17:19')).toBe(true);
    expect(rule.pattern.test('o prompt diz Worked for 4m 21s • 17:52 e segue')).toBe(false);
    expect(rule.pattern.test('A resposta contém   Worked for 2s • 05:54 no meio')).toBe(false);
    expect(rule.pattern.test('  eco do prompt: Worked for 1s • 17:19')).toBe(false);
  });
});
