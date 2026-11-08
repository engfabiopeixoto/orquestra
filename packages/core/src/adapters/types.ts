import type { ScreenRule } from '../screen-watcher.js';

export type HookSignal =
  /** model: modelo que o agente informa no hook (o agy manda modelName no Stop). */
  | { kind: 'turn-end'; text: string | null; transcriptPath: string | null; agentSessionId: string | null; completionId?: string; model?: string }
  | { kind: 'activity' }
  | { kind: 'turn-failed' }
  | { kind: 'waiting'; detail: string }
  | { kind: 'session-start'; agentSessionId: string | null; model?: string }
  | { kind: 'ignored' };

export type ScreenSignal = 'waiting' | 'interrupted' | 'failed' | 'turn-end';

export type LaunchContext = {
  cwd: string;
  sessionDir: string;
  /** Comando completo do hook para um evento: `node <bin>/orq.mjs hook <agente> <evento>`. */
  hookCommand: (event: string) => string;
  /** Id da sessão anterior do agente, quando o terminal deve retomá-la. */
  resumeSessionId: string | null;
  /** Stable Orquestra terminal ID, preserved across restarts. */
  terminalId?: string;
  /** Identidade e papel que continuam disponíveis ao retomar o terminal. */
  terminalName?: string;
  regente?: boolean;
  /** Modelo escolhido na tag do terminal: o adapter passa na flag de modelo do CLI. */
  model?: string | null;
};

/** agentSessionId: id já conhecido no lançamento (o Claude nasce com --session-id). */
export type LaunchSpec = { command: string; args: string[]; env: Record<string, string>; agentSessionId?: string };

export interface AgentAdapter {
  readonly kind: string;
  readonly acceptsPrompts: boolean;
  readonly screenRules: ScreenRule<ScreenSignal>[];
  launch(ctx: LaunchContext): LaunchSpec;
  interpretHook(event: string, payload: unknown): HookSignal;
  /** Resposta final do turno atual, ou null se ainda não existe. */
  readTranscript?(path: string): Promise<string | null>;
  preparePrompt(text: string, ctx: { cwd: string; askId: string }): string;
  encodeInput?(body: string): string;
}
