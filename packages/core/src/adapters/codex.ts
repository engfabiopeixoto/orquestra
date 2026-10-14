import type { AgentAdapter } from './types.js';
import { orquestraGuide, parseArgs } from '@orquestra/shared';

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  acceptsPrompts: true,
  screenRules: [
    { pattern: /Would you like to run|Do you trust|Approve this/, signal: 'waiting' },
    { pattern: /Turn interrupted/, signal: 'interrupted', scope: 'new-occurrence' },
    { pattern: /You've hit your usage limit|Usage limit reached/, signal: 'failed', scope: 'new-occurrence' },
  ],
  launch(ctx) {
    // notify appends its JSON payload as the last argument, rather than stdin.
    const command = parseArgs(ctx.hookCommand('Stop'));
    const config = [
      '-c', `notify=${JSON.stringify(command)}`,
      '-c', 'disable_paste_burst=true',
      '-c', `developer_instructions=${JSON.stringify(orquestraGuide({ terminalName: ctx.terminalName, regent: ctx.regente ?? false, cliScript: command[1]!, nodePath: process.execPath }))}`,
      '-c', `mcp_servers.orquestra.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.orquestra.args=${JSON.stringify([command[1]!, 'mcp'])}`,
      '-c', 'mcp_servers.orquestra.env_vars=["ORQ_PIPE","ORQ_TOKEN"]',
      '-c', 'mcp_servers.orquestra.enabled=true',
      '-c', 'mcp_servers.orquestra.startup_timeout_sec=15',
      '-c', 'mcp_servers.orquestra.tool_timeout_sec=660',
    ];
    return {
      command: 'codex',
      args: ctx.resumeSessionId ? ['resume', ctx.resumeSessionId, ...config] : config,
      env: {},
      ...(ctx.resumeSessionId ? { agentSessionId: ctx.resumeSessionId } : {}),
    };
  },
  interpretHook(event, payload) {
    if (event !== 'Stop' || !payload || typeof payload !== 'object') return { kind: 'ignored' };
    const data = payload as Record<string, unknown>;
    if (data.type !== 'agent-turn-complete') return { kind: 'ignored' };
    return {
      kind: 'turn-end',
      text: typeof data['last-assistant-message'] === 'string' ? data['last-assistant-message'] : null,
      transcriptPath: null,
      agentSessionId: typeof data['thread-id'] === 'string' ? data['thread-id'] : null,
      ...(typeof data['turn-id'] === 'string' ? { completionId: `${data['thread-id'] ?? ''}:${data['turn-id']}` } : {}),
    };
  },
  preparePrompt: (text) => text,
};
