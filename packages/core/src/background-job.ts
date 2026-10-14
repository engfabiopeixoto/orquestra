import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from './log.js';

/** Conversa do Claude Code que o daemon (`claude daemon run`) mantém em segundo plano. */
export type BackgroundJob = { id8: string; state: string };

const ID8 = /^[0-9a-z]{8}$/i;
const POLL_MS = 5000;
/** Pastas antigas ficam em jobs/ para sempre com done ou stopped. Os demais nomes variam entre versões do Claude Code; o pipe vivo decide. */
const FINISHED_STATES = new Set(['done', 'stopped']);

/** Nomes dos named pipes do Windows (\.\pipe\). Injetável nos testes; falha vira lista vazia. */
export type ListPipes = () => string[];
export const listWindowsPipes: ListPipes = () => {
  try {
    return readdirSync('\\\\.\\pipe\\');
  } catch {
    return [];
  }
};

/** Pasta de configuração do Claude Code: CLAUDE_CONFIG_DIR, senão ~/.claude. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude');
}

/**
 * Lê ~/.claude/jobs/<id8>/state.json. Só conta quando o job é do daemon, é desta mesma sessão
 * (dois ids podem compartilhar os 8 primeiros caracteres), está num estado ativo E está vivo:
 * o pty host do daemon mantém o pipe cc-daemon-<hash>-pty-<id8> enquanto a conversa roda.
 */
export function readBackgroundJob(claudeDir: string, sessionId: string, listPipes: ListPipes = listWindowsPipes): BackgroundJob | null {
  const id8 = sessionId.slice(0, 8);
  // O id vem de um hook: só aceita o formato esperado antes de virar caminho de arquivo.
  if (!ID8.test(id8)) return null;
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(join(claudeDir, 'jobs', id8, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!state || typeof state !== 'object') return null;
  const job = state as { backend?: unknown; sessionId?: unknown; state?: unknown };
  if (job.backend !== 'daemon' || job.sessionId !== sessionId) return null;
  const jobState = typeof job.state === 'string' ? job.state : 'unknown';
  if (FINISHED_STATES.has(jobState)) return null;
  const alive = safePipes(listPipes).some((pipe) => pipe.startsWith('cc-daemon-') && pipe.endsWith(`-pty-${id8}`));
  return alive ? { id8, state: jobState } : null;
}

function safePipes(listPipes: ListPipes): string[] {
  try {
    return listPipes();
  } catch {
    return [];
  }
}

export function backgroundJobNotice(job: BackgroundJob): string {
  return `Conversa em segundo plano: sem conexão com o Orquestra. Rode \`claude stop ${job.id8}\` e reinicie este terminal.`;
}

export function backgroundJobError(terminal: string, job: BackgroundJob): string {
  return `${terminal} está com a conversa em segundo plano e sem conexão com o Orquestra. Rode \`claude stop ${job.id8}\` e reinicie o terminal.`;
}

export type BackgroundJobWatcherOptions = {
  claudeDir: string;
  /** Lido a cada verificação: o id do Claude é aprendido depois do lançamento. */
  sessionId: () => string | null;
  log: Logger;
  pollMs?: number;
  /** Lista os named pipes do sistema; padrão: \.\pipe\. */
  listPipes?: ListPipes;
  /** Só nas transições: o job apareceu (ou mudou de id) ou sumiu (null). */
  onChange: (job: BackgroundJob | null) => void;
  /** A cada verificação periódica com o job ativo; reemite o aviso depois que a interface recarrega. */
  onPoll?: (job: BackgroundJob) => void;
};

/** Observa o job de uma sessão com fs.watch (rápido) e polling (garantia, e cobre a pasta jobs ainda inexistente). */
export class BackgroundJobWatcher {
  private current: BackgroundJob | null = null;
  private timer: NodeJS.Timeout | undefined;
  private fsWatcher: FSWatcher | null = null;
  private stopped = false;

  constructor(private readonly opts: BackgroundJobWatcherOptions) {}

  get job(): BackgroundJob | null {
    return this.current;
  }

  start(): void {
    this.stopped = false;
    this.attachWatcher();
    this.check();
    this.timer = setInterval(() => {
      this.attachWatcher();
      this.check();
      if (this.current) this.opts.onPoll?.(this.current);
    }, this.opts.pollMs ?? POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  /** Relê o estado e notifica só quando o job surgiu, trocou de id ou sumiu. */
  check(): void {
    if (this.stopped) return;
    const id = this.opts.sessionId();
    const job = id ? readBackgroundJob(this.opts.claudeDir, id, this.opts.listPipes) : null;
    const previous = this.current;
    this.current = job;
    if (previous?.id8 === job?.id8) return;
    this.opts.log.info({ sessionId: id, job }, job ? 'conversa em segundo plano detectada' : 'conversa voltou do segundo plano');
    this.opts.onChange(job);
  }

  private attachWatcher(): void {
    if (this.fsWatcher || this.stopped) return;
    try {
      const watcher = watch(join(this.opts.claudeDir, 'jobs'), { recursive: true }, (_event, filename) => {
        const id = this.opts.sessionId();
        // Só interessa a pasta do próprio job; o resto da atividade do daemon não conta.
        if (id && filename && !String(filename).startsWith(id.slice(0, 8))) return;
        this.check();
      });
      watcher.on('error', () => { watcher.close(); if (this.fsWatcher === watcher) this.fsWatcher = null; });
      this.fsWatcher = watcher;
    } catch {
      // Pasta jobs inexistente: o polling tenta de novo no próximo ciclo.
    }
  }
}
