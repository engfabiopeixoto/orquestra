import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.js';

/**
 * O Claude Code mantém ~/.claude/sessions/<pid>.json de cada sessão interativa, com `status` ("idle", "busy",
 * "waiting", "shell"…). É a fonte confiável de que o turno acabou quando o fim não vem por hook: um Esc antes do
 * primeiro token (Claude Code 2.1.300) desfaz o turno e devolve o texto à caixa de entrada, sem Stop, sem
 * "Interrupted" na tela e sem marcador no transcript. Aí o status só volta de busy para idle.
 */
const sessionFile = z.object({ pid: z.number().int(), sessionId: z.string(), status: z.string(), statusUpdatedAt: z.number().optional() });

/**
 * Tecla que limpa a caixa de entrada do Claude Code. Depois de um Esc antes do primeiro token ele devolve o texto
 * do pedido à caixa; sem limpar, o próximo pedido da fila seria digitado em cima dele. Com a caixa cheia, um
 * Ctrl+C só a limpa (verificado no 2.1.300) e não encerra o claude.
 */
export const CLAUDE_CLEAR_INPUT = String.fromCharCode(3);

export type ClaudeSessionStatus = { status: string; sessionId: string; pid: number; statusUpdatedAt: number | null };
export type ClaudeSessionRef = { pid?: number | null; sessionId?: string | null };

/** Procura o arquivo da sessão pelo pid do terminal (ou pelo sessionId). Sem arquivo legível, devolve null. */
export function readClaudeSessionStatus(sessionsDir: string, who: ClaudeSessionRef): ClaudeSessionStatus | null {
  if (!who.pid && !who.sessionId) return null;
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof sessionFile>>;
    try {
      parsed = sessionFile.safeParse(JSON.parse(readFileSync(join(sessionsDir, name), 'utf8')));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const file = parsed.data;
    if ((who.pid && file.pid === who.pid) || (who.sessionId && file.sessionId === who.sessionId)) {
      return { status: file.status, sessionId: file.sessionId, pid: file.pid, statusUpdatedAt: file.statusUpdatedAt ?? null };
    }
  }
  return null;
}

export type ClaudeStatusWatcherOptions = {
  sessionsDir: string;
  /** Lido a cada verificação: o pid e o id da sessão podem mudar com o relançamento. */
  who: () => ClaudeSessionRef;
  log: Logger;
  pollMs?: number;
  /** Status diferente de idle: o agente está trabalhando (ou esperando por você). */
  onBusy: () => void;
  /** O status voltou a idle depois de ter sido visto ocupado, uma vez por ocupado. */
  onIdle: () => void;
};

/**
 * Lê o status enquanto há turno em curso. O claude demora algumas centenas de ms para sair de idle depois do
 * prompt, então um idle só vale como "o turno acabou" se houve busy: ou foi amostrado, ou o status mudou depois
 * do início do turno (statusUpdatedAt). O segundo caso cobre um Esc tão rápido que o busy durou menos que o
 * intervalo de leitura.
 */
export class ClaudeStatusWatcher {
  private timer: NodeJS.Timeout | undefined;
  private sawBusy = false;
  private reportedIdle = false;
  private startedAt = 0;

  constructor(private readonly opts: ClaudeStatusWatcherOptions) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.sawBusy = false;
    this.reportedIdle = false;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 200);
    this.timer.unref();
    this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    const current = readClaudeSessionStatus(this.opts.sessionsDir, this.opts.who());
    if (!current) return;
    if (current.status !== 'idle') {
      this.sawBusy = true;
      this.reportedIdle = false;
      this.opts.onBusy();
      return;
    }
    const changedSinceStart = current.statusUpdatedAt !== null && current.statusUpdatedAt >= this.startedAt;
    if (!(this.sawBusy || changedSinceStart) || this.reportedIdle) return;
    this.reportedIdle = true;
    this.opts.log.info({ sessionId: current.sessionId, pid: current.pid }, 'claude ocioso sem fim de turno por hook');
    this.opts.onIdle();
  }
}
