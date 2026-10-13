import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from './scenarios.js';

export type AgentKind = 'fake' | 'claude' | 'codex' | 'agy';

export type HookEnvelope = {
  agent: AgentKind;
  event: string;
  payload: unknown;
  receivedAt: number;
};

export type TurnSignal =
  | { kind: 'turn-end'; text: string | null; transcriptPath: string | null; sessionId: string | null }
  | { kind: 'waiting-user'; detail: string }
  | { kind: 'session-start'; sessionId: string | null }
  | { kind: 'ignored' };

export type LaunchContext = {
  workDir: string;
  sessionDir: string;
};

export type LaunchSpec = {
  name: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * Teclas enviadas uma vez cada vez que o padrão aparece na parte visível da tela.
 * Cada item de `keys` vai num write separado: a TUI ignora teclas que chegam antes de ela ler o teclado.
 */
export type AutoAnswer = {
  whenScreen: RegExp;
  keys: string[];
  /** Restringe a resposta ao cenário em curso (undefined antes do primeiro prompt). */
  onlyWhen?: (scenario: Scenario | undefined) => boolean;
};

export interface AgentDriver {
  kind: AgentKind;
  pasteMode: 'bracketed' | 'plain';
  /** Só para pastas temporárias da prova de conceito: confiança na pasta e permissões. */
  autoAnswers?: AutoAnswer[];
  launch(ctx: LaunchContext): LaunchSpec;
  interpret(envelope: HookEnvelope): TurnSignal;
  readTranscript?(path: string): Promise<string | null>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const RELAY_PATH = join(here, 'hook-relay.mjs').replaceAll('\\', '/');

export function relayCommand(agent: AgentKind, event: string): string {
  return `node "${RELAY_PATH}" ${agent} ${event}`;
}
