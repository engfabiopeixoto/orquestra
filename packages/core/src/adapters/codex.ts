import type { AgentAdapter } from './types.js';
import { orquestraGuide, parseArgs } from '@orquestra/shared';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type CodexCompletion = { completionId: string | null; text: string | null };

export async function readCodexRolloutCompletion(threadId: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): Promise<CodexCompletion | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(threadId)) return null;
  const sessionsDir = join(codexHome, 'sessions');
  let files: string[] = [];
  try {
    for (const year of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      for (const month of await readdir(join(sessionsDir, year.name), { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        for (const day of await readdir(join(sessionsDir, year.name, month.name), { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          const directory = join(sessionsDir, year.name, month.name, day.name);
          files.push(...(await readdir(directory)).filter((name) => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)).map((name) => join(directory, name)));
        }
      }
    }
  } catch {
    return null;
  }
  files.sort();
  let latest: CodexCompletion | null = null;
  for (const file of files) {
    const messages = new Map<string, string>();
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
      const event = typeof payload.type === 'string' ? payload.type : '';
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : typeof row.turn_id === 'string' ? row.turn_id : '';
      if (event === 'agent_message' && turnId) {
        const text = typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : null;
        if (text) messages.set(turnId, text);
      }
      if (row.type === 'response_item' && event === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer' && turnId && Array.isArray(payload.content)) {
        const text = payload.content.flatMap((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'output_text' && typeof (item as Record<string, unknown>).text === 'string' ? [(item as Record<string, unknown>).text as string] : []).join('');
        if (text) messages.set(turnId, text);
      }
      if (event === 'task_complete') {
        const answer = typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()
          ? payload.last_agent_message
          : messages.get(turnId) ?? null;
        latest = { completionId: turnId ? `${threadId}:${turnId}` : null, text: answer };
      }
    }
  }
  return latest;
}

function tomlString(value: string): string { return JSON.stringify(value); }

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  acceptsPrompts: true,
  screenRules: [
    { pattern: /Would you like to run|Do you trust|Trust this folder\?|Approve this/, signal: 'waiting' },
    { pattern: /^  Worked for (?:(?:\d+h )?\d+m(?: \d+s)?|\d+s) • \d{1,2}:\d{2}[ \t]*$/m, signal: 'turn-end', scope: 'new-occurrence' },
    // A TUI escreve o marcador na coluna 0; respostas e o eco quebrado do prompt vêm recuados.
    { pattern: /^■\s*(?:Turn|Conversation) interrupted\b/m, signal: 'interrupted', scope: 'new-occurrence' },
    { pattern: /You've hit your usage limit|Usage limit reached/, signal: 'failed', scope: 'new-occurrence' },
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
  readScreenCompletion: readCodexRolloutCompletion,
  preparePrompt: (text) => text,
};
