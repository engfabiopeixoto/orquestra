import type { AgentAdapter } from './types.js';

export const shellAdapter: AgentAdapter = {
  kind: 'shell',
  acceptsPrompts: false,
  screenRules: [],
  launch: () => ({ command: 'powershell', args: ['-NoLogo'], env: {} }),
  interpretHook: () => ({ kind: 'ignored' }),
  preparePrompt: (text) => text,
};
