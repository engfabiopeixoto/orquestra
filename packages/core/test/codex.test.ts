import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codexAdapter } from '../src/adapters/codex.js';

const hooksReviewCapture = readFileSync(fileURLToPath(new URL('./fixtures/codex-rollouts/hooks-need-review-screen.txt', import.meta.url)), 'utf8');

describe('Codex', () => {
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

  it('mantém apenas diálogos visíveis como regras de espera, incluindo linhas em branco', () => {
    const rules = codexAdapter.screenRules;
    expect(rules.every((entry) => entry.signal === 'waiting' && entry.scope === 'visible')).toBe(true);
    const rule = rules.find((entry) => entry.pattern.test(hooksReviewCapture))!;
    expect(rule.pattern.test(hooksReviewCapture)).toBe(true);
    expect(rule.pattern.test('The answer says “Hooks need review” but continues with the task.')).toBe(false);
    expect(rules.some((entry) => entry.signal === 'turn-end' || entry.signal === 'interrupted')).toBe(false);
  });
});
