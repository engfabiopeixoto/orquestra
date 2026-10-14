import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readClaudeTranscript } from './claude-transcript.js';
import type { AgentAdapter, HookSignal } from './types.js';

const stopPayload = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
});
const notificationPayload = z.object({ message: z.string().optional(), notification_type: z.string().optional() });
const sessionStartPayload = z.object({ session_id: z.string().optional() });

export function claudeHookSettings(hookCommand: (event: string) => string): object {
  const handler = (event: string) => ({ type: 'command', command: hookCommand(event), timeout: 10 });
  return {
    hooks: {
      Stop: [{ hooks: [handler('Stop')] }],
      UserPromptSubmit: [{ hooks: [handler('UserPromptSubmit')] }],
      PostToolUse: [{ hooks: [handler('PostToolUse')] }],
      PostToolUseFailure: [{ hooks: [handler('PostToolUseFailure')] }],
      StopFailure: [{ hooks: [handler('StopFailure')] }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [handler('Notification')] }],
      SessionStart: [{ hooks: [handler('SessionStart')] }],
    },
  };
}

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  acceptsPrompts: true,
  screenRules: [
    { pattern: /Yes, I trust this folder/, signal: 'waiting' },
    { pattern: /Do you want to (proceed|create|make this edit)/, signal: 'waiting' },
    // Confirmado no Claude Code 2.1.295 quando o Esc chega com a resposta sendo escrita. Se o Esc chega
    // ainda no raciocínio, o Claude devolve o prompt ao campo de entrada sem essa linha (pendência da fase 2).
    { pattern: /Interrupted · What should Claude do instead\?/, signal: 'interrupted', scope: 'new-occurrence' },
    // Limite de uso e erro de API encerram o turno sem Stop (visto na fase 1).
    { pattern: /You've hit your (?:session |usage |weekly )?limit|API Error: \d{3}/, signal: 'failed', scope: 'new-occurrence' },
  ],
  launch: (ctx) => {
    const settingsPath = join(ctx.sessionDir, 'claude-settings.json');
    writeFileSync(settingsPath, JSON.stringify(claudeHookSettings(ctx.hookCommand), null, 2));
    const settings = ['--settings', settingsPath];
    if (ctx.resumeSessionId) return { command: 'claude', args: [...settings, '--resume', ctx.resumeSessionId], env: {}, agentSessionId: ctx.resumeSessionId };
    const id = randomUUID();
    return { command: 'claude', args: [...settings, '--session-id', id], env: {}, agentSessionId: id };
  },
  interpretHook: (event, payload): HookSignal => {
    if (['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'StopFailure'].includes(event)) {
      if (!payload || typeof payload !== 'object') return { kind: 'ignored' };
      // Hooks de subagentes não encerram nem abrem o turno do terminal principal.
      if ('agent_id' in payload) return { kind: 'ignored' };
      return { kind: event === 'StopFailure' ? 'turn-failed' : 'activity' };
    }
    if (event === 'Stop') {
      const parsed = stopPayload.safeParse(payload);
      if (!parsed.success) return { kind: 'ignored' };
      return {
        kind: 'turn-end',
        text: parsed.data.last_assistant_message ?? null,
        transcriptPath: parsed.data.transcript_path ?? null,
        agentSessionId: parsed.data.session_id ?? null,
      };
    }
    if (event === 'Notification') {
      const parsed = notificationPayload.safeParse(payload);
      if (parsed.success && parsed.data.notification_type && !['permission_prompt', 'elicitation_dialog'].includes(parsed.data.notification_type)) return { kind: 'ignored' };
      return parsed.success ? { kind: 'waiting', detail: parsed.data.message ?? parsed.data.notification_type ?? '' } : { kind: 'ignored' };
    }
    if (event === 'SessionStart') {
      const parsed = sessionStartPayload.safeParse(payload);
      return parsed.success ? { kind: 'session-start', agentSessionId: parsed.data.session_id ?? null } : { kind: 'ignored' };
    }
    return { kind: 'ignored' };
  },
  readTranscript: readClaudeTranscript,
  preparePrompt: (text) => text,
};
