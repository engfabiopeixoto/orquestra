import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from '../../src/adapters/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

export function createFakeAdapter(env: Record<string, string> = {}): AgentAdapter {
  return {
    kind: 'fake',
    acceptsPrompts: true,
    screenRules: [{ pattern: /Interrupted · What should Fake do instead\?/, signal: 'interrupted', scope: 'new-occurrence' }],
    launch: (ctx) => ({
      command: 'node',
      args: [fakeAgentPath, ...(ctx.resumeSessionId ? ['--resume', ctx.resumeSessionId] : [])],
      env: { ...env, FAKE_HOOK_CMD: ctx.hookCommand('Stop') },
    }),
    interpretHook: (event, payload) => {
      if (event !== 'Stop') return { kind: 'ignored' };
      const text = (payload as { last_assistant_message?: string }).last_assistant_message ?? null;
      return { kind: 'turn-end', text, transcriptPath: null, agentSessionId: null };
    },
    preparePrompt: (text) => text,
  };
}
