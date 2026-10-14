import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';

describe('Codex', () => {
  it('notify preserva o caminho do hook com espaços', () => {
    const args = codexAdapter.launch({ ...context, hookCommand: (event) => `node "C:/Program Files/Orquestra/orq.mjs" hook codex ${event}` }).args;
    expect(JSON.parse(args[1]!.slice('notify='.length))).toEqual(['node', 'C:/Program Files/Orquestra/orq.mjs', 'hook', 'codex', 'Stop']);
  });
  const context = { cwd: 'C:/project', sessionDir: 'C:/session', hookCommand: (event: string) => `node C:/orq/orq.mjs hook codex ${event}`, resumeSessionId: null as string | null };
  it('configura notify e retoma somente a sessão associada ao terminal', () => {
    const launch = codexAdapter.launch(context);
    expect(launch.command).toBe('codex');
    expect(JSON.parse(launch.args[1]!.slice('notify='.length))).toEqual(['node', 'C:/orq/orq.mjs', 'hook', 'codex', 'Stop']);
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
});
