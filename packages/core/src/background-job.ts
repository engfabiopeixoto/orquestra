import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
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

const normalizePath = (path: string) => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();

/** Pastas de sessão citadas em `--settings <arquivo>` / `--settings=<arquivo>` do respawnFlags do job. */
function settingsDirs(respawnFlags: unknown): string[] {
  if (!Array.isArray(respawnFlags)) return [];
  const dirs: string[] = [];
  respawnFlags.forEach((flag, index) => {
    if (typeof flag !== 'string') return;
    const value = flag === '--settings' ? respawnFlags[index + 1] : flag.startsWith('--settings=') ? flag.slice('--settings='.length) : undefined;
    if (typeof value === 'string' && value !== '') dirs.push(win32.dirname(value));
  });
  return dirs;
}

/** ids (8 primeiros caracteres) das conversas com pty host vivo: cc-daemon-<hash>-pty-<id8>. */
function livePtyIds(listPipes: ListPipes): string[] {
  const ids = new Set<string>();
  for (const pipe of safePipes(listPipes)) {
    const match = /^cc-daemon-.+-pty-([0-9a-z]{8})$/i.exec(pipe);
    if (match) ids.add(match[1]!);
  }
  return [...ids];
}

export type FindBackgroundJobOptions = {
  claudeDir: string;
  /**
   * Pastas de sessão dos lançamentos do terminal (<dataDir>\sessions\<uuid>). O /bg cria a conversa com um
   * sessionId novo, mas o respawnFlags do job guarda o --settings desse lançamento: é o vínculo confiável.
   */
  sessionDirs?: string[];
  /** Vínculo antigo: o job tem o mesmo sessionId do terminal. */
  sessionId?: string | null;
  listPipes?: ListPipes;
};

/**
 * Procura, em ~/.claude/jobs/*, a conversa em segundo plano do terminal. O job precisa ser do daemon,
 * não estar finalizado e estar VIVO (pipe do pty host); pastas antigas ficam em jobs/ para sempre.
 * Só os jobs com pipe vivo têm o state.json lido, o que mantém a varredura barata.
 */
export function findBackgroundJob(opts: FindBackgroundJobOptions): BackgroundJob | null {
  const dirs = new Set((opts.sessionDirs ?? []).map(normalizePath));
  if (dirs.size === 0 && !opts.sessionId) return null;
  for (const id8 of livePtyIds(opts.listPipes ?? listWindowsPipes)) {
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(join(opts.claudeDir, 'jobs', id8, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!state || typeof state !== 'object') continue;
    const job = state as { backend?: unknown; sessionId?: unknown; state?: unknown; respawnFlags?: unknown };
    if (job.backend !== 'daemon') continue;
    const jobState = typeof job.state === 'string' ? job.state : 'unknown';
    if (FINISHED_STATES.has(jobState)) continue;
    const sameSession = Boolean(opts.sessionId) && job.sessionId === opts.sessionId;
    const sameLaunch = dirs.size > 0 && settingsDirs(job.respawnFlags).some((dir) => dirs.has(normalizePath(dir)));
    if (sameSession || sameLaunch) return { id8, state: jobState };
  }
  return null;
}

/** Vínculo pelo sessionId do terminal (dois ids podem compartilhar os 8 primeiros caracteres: o sessionId inteiro decide). */
export function readBackgroundJob(claudeDir: string, sessionId: string, listPipes: ListPipes = listWindowsPipes): BackgroundJob | null {
  // O id vem de um hook: só aceita o formato esperado.
  if (!ID8.test(sessionId.slice(0, 8))) return null;
  return findBackgroundJob({ claudeDir, sessionId, listPipes });
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
  /** Pastas de sessão dos lançamentos do terminal (ver FindBackgroundJobOptions.sessionDirs); lidas a cada verificação. */
  sessionDirs?: () => string[];
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
  private pending: NodeJS.Timeout | undefined;
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
    clearTimeout(this.pending);
    this.timer = undefined;
    this.pending = undefined;
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  /** Relê o estado e notifica só quando o job surgiu, trocou de id ou sumiu. */
  check(): void {
    if (this.stopped) return;
    const id = this.opts.sessionId();
    const job = findBackgroundJob({ claudeDir: this.opts.claudeDir, sessionId: id, sessionDirs: this.opts.sessionDirs?.() ?? [], listPipes: this.opts.listPipes });
    const previous = this.current;
    this.current = job;
    if (previous?.id8 === job?.id8) return;
    this.opts.log.info({ sessionId: id, job }, job ? 'conversa em segundo plano detectada' : 'conversa voltou do segundo plano');
    this.opts.onChange(job);
  }

  /** Agrupa rajadas de eventos do fs.watch numa única leitura. */
  private scheduleCheck(): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.check();
    }, 200);
    this.pending.unref();
  }

  private attachWatcher(): void {
    if (this.fsWatcher || this.stopped) return;
    try {
      const watcher = watch(join(this.opts.claudeDir, 'jobs'), { recursive: true }, (_event, filename) => {
        // O daemon grava timeline.jsonl o tempo todo; só a mudança de estado de um job interessa.
        if (filename && !String(filename).endsWith('state.json')) return;
        this.scheduleCheck();
      });
      watcher.on('error', () => { watcher.close(); if (this.fsWatcher === watcher) this.fsWatcher = null; });
      this.fsWatcher = watcher;
    } catch {
      // Pasta jobs inexistente: o polling tenta de novo no próximo ciclo.
    }
  }
}
