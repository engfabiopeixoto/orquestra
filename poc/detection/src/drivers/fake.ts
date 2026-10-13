import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_PATH, type AgentDriver, type TurnSignal } from '../types.js';

const fakeAgentPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-agent.mjs');

export const fakeDriver: AgentDriver = {
  kind: 'fake',
  pasteMode: 'bracketed',
  launch: () => ({ name: 'node', args: [fakeAgentPath], env: { FAKE_RELAY_PATH: RELAY_PATH } }),
  interpret: (envelope): TurnSignal => {
    const payload = envelope.payload as { last_assistant_message?: string; session_id?: string };
    if (envelope.event !== 'Stop') return { kind: 'ignored' };
    return {
      kind: 'turn-end',
      text: payload.last_assistant_message ?? null,
      transcriptPath: null,
      sessionId: payload.session_id ?? null,
    };
  },
};
