import type { AgentAdapter } from './types.js';
import { orquestraGuide, parseArgs } from '@orquestra/shared';

function tomlString(value: string): string { return JSON.stringify(value); }

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  acceptsPrompts: true,
  screenRules: [
    { pattern: /Hooks need review[\s\S]*1\. Review hooks[\s\S]*2\. Trust all and continue[\s\S]*3\. Continue without trusting \(hooks won't run\)/, signal: 'waiting', scope: 'visible' },
    { pattern: /Would you like to run|Do you trust|Trust this folder\?|Approve this/, signal: 'waiting', scope: 'visible' },
  ],
  launch(ctx) {
    const command = ctx.hookCommand('Stop');
    const handler = (event: string) => `{type="command",command=${tomlString(ctx.hookCommand(event))},timeout=10}`;
    const config = [
      '-c', 'features.hooks=true',
      '-c', `hooks.Stop=[{hooks=[${handler('Stop')}]}]`,
      '-c', `hooks.SessionStart=[{hooks=[${handler('SessionStart')}]}]`,
      // Desativa notify legado global para impedir que o historico entre no argv.
      '-c', 'notify=[]',
      '-c', 'disable_paste_burst=true',
      '-c', `developer_instructions=${JSON.stringify(orquestraGuide({ terminalName: ctx.terminalName, regent: ctx.regente ?? false, cliScript: parseArgs(command)[1]!, nodePath: process.execPath }))}`,
      '-c', `mcp_servers.orquestra.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.orquestra.args=${JSON.stringify([parseArgs(command)[1]!, 'mcp'])}`,
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
    if (!payload || typeof payload !== 'object') return { kind: 'ignored' };
    const data = payload as Record<string, unknown>;
    if (event === 'SessionStart' && data.hook_event_name === 'SessionStart') {
      return { kind: 'session-start', agentSessionId: typeof data.session_id === 'string' ? data.session_id : null };
    }
    if (event !== 'Stop') return { kind: 'ignored' };
    const hookEvent = data.hook_event && typeof data.hook_event === 'object' ? data.hook_event as Record<string, unknown> : {};
    const modern = data.hook_event_name === 'Stop' || hookEvent.event_type === 'after_agent';
    if (!modern && data.type !== 'agent-turn-complete') return { kind: 'ignored' };
    const threadId = [data['thread-id'], data.thread_id, data.session_id, hookEvent.thread_id].find((value) => typeof value === 'string');
    const turnId = [data['turn-id'], data.turn_id, hookEvent.turn_id].find((value) => typeof value === 'string');
    const answer = [data['last-assistant-message'], data.last_assistant_message, hookEvent.last_assistant_message].find((value) => typeof value === 'string');
    return {
      kind: 'turn-end',
      text: typeof answer === 'string' ? answer : null,
      transcriptPath: null,
      agentSessionId: typeof threadId === 'string' ? threadId : null,
      ...(typeof turnId === 'string' ? { completionId: `${typeof threadId === 'string' ? threadId : ''}:${turnId}` } : {}),
    };
  },
  preparePrompt: (text) => text,
};
