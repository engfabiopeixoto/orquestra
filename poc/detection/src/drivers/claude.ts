import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { relayCommand, type AgentDriver, type TurnSignal } from '../types.js';
import { extractLastAssistantFromTranscript } from './transcript.js';

const stopPayload = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
});
const notificationPayload = z.object({ notification_type: z.string().optional(), message: z.string().optional() });
const sessionStartPayload = z.object({ session_id: z.string().optional() });

const hook = (event: string) => ({ type: 'command', command: relayCommand('claude', event), timeout: 10 });

export function claudeHookSettings(): object {
  return {
    hooks: {
      Stop: [{ hooks: [hook('Stop')] }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [hook('Notification')] }],
      SessionStart: [{ hooks: [hook('SessionStart')] }],
    },
  };
}

export const claudeDriver: AgentDriver = {
  kind: 'claude',
  pasteMode: 'bracketed',
  autoAnswers: [
    // O padrão do diálogo é "No, exit": desce uma opção e confirma.
    { whenScreen: /Yes, I trust this folder/, keys: ['\x1b[B', '\r'] },
    { whenScreen: /Do you want to (proceed|create|make this edit)/, keys: ['1'], onlyWhen: (scenario) => scenario?.allowTools === true },
    { whenScreen: /Do you want to (proceed|create|make this edit)/, keys: ['\x1b'], onlyWhen: (scenario) => scenario?.allowTools !== true },
  ],
  launch: (ctx) => {
    const settingsPath = join(ctx.sessionDir, 'claude-settings.json');
    writeFileSync(settingsPath, JSON.stringify(claudeHookSettings(), null, 2));
    return { name: 'claude', args: ['--settings', settingsPath], env: {} };
  },
  interpret: (envelope): TurnSignal => {
    if (envelope.event === 'Stop') {
      const parsed = stopPayload.safeParse(envelope.payload);
      if (!parsed.success) return { kind: 'ignored' };
      return {
        kind: 'turn-end',
        text: parsed.data.last_assistant_message ?? null,
        transcriptPath: parsed.data.transcript_path ?? null,
        sessionId: parsed.data.session_id ?? null,
      };
    }
    if (envelope.event === 'Notification') {
      const parsed = notificationPayload.safeParse(envelope.payload);
      return parsed.success
        ? { kind: 'waiting-user', detail: parsed.data.message ?? parsed.data.notification_type ?? '' }
        : { kind: 'ignored' };
    }
    if (envelope.event === 'SessionStart') {
      const parsed = sessionStartPayload.safeParse(envelope.payload);
      return parsed.success ? { kind: 'session-start', sessionId: parsed.data.session_id ?? null } : { kind: 'ignored' };
    }
    return { kind: 'ignored' };
  },
  readTranscript: extractLastAssistantFromTranscript,
};
