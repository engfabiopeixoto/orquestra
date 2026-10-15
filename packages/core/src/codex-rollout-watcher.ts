import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Logger } from './log.js';

export type CodexRolloutEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'task-started'; sessionId: string; turnId: string }
  | { kind: 'task-complete'; sessionId: string; turnId: string; answer: string | null }
  | { kind: 'turn-aborted'; sessionId: string; turnId: string; reason: string | null };

export type CodexRolloutWatcherOptions = {
  codexHome?: string;
  cwd: string;
  terminalName: string;
  sessionId?: string | null;
  startedAt?: number;
  pollMs?: number;
  discoveryMs?: number;
  log: Logger;
  onEvent: (event: CodexRolloutEvent) => void;
};

type ParsedRolloutEvent =
  | { kind: 'task-started'; turnId: string }
  | { kind: 'task-complete'; turnId: string; answer: string | null }
  | { kind: 'turn-aborted'; turnId: string; reason: string | null };

class RolloutCursor {
  private pending = Buffer.alloc(0);
  offset: number;
  readonly path: string;
  readonly handle: FileHandle;

  private constructor(path: string, handle: FileHandle, offset: number) {
    this.path = path;
    this.handle = handle;
    this.offset = offset;
  }

  static async open(path: string, fromEnd: boolean): Promise<RolloutCursor> {
    const handle = await open(path, 'r');
    const offset = fromEnd ? (await handle.stat()).size : 0;
    return new RolloutCursor(path, handle, offset);
  }

  async readLines(): Promise<string[]> {
    const currentSize = (await this.handle.stat()).size;
    const chunks: Buffer[] = [];
    while (this.offset < currentSize) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, currentSize - this.offset));
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (chunks.length === 0) return [];
    const lines = Buffer.concat([this.pending, ...chunks]).toString('utf8').split('\n');
    this.pending = Buffer.from(lines.pop() ?? '', 'utf8');
    return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }
}

type Candidate = {
  cursor: RolloutCursor;
  sessionId: string | null;
  eligible: boolean;
  selected: boolean;
  pendingEvents: Array<{ kind: 'task-started'; turnId: string } | { kind: 'task-complete'; turnId: string; answer: string | null } | { kind: 'turn-aborted'; turnId: string; reason: string | null }>;
};

/** Associa a thread pelo ID ou pelo cwd e a identidade que o Codex registra em response_item/developer. */
export class CodexRolloutWatcher {
  private readonly home: string;
  private readonly startedAt: number;
  private readonly pollMs: number;
  private readonly discoveryMs: number;
  private readonly candidates = new Map<string, Candidate>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = false;
  private selected: Candidate | null = null;
  private expectedSessionId: string | null;
  private nextDiscoveryAt = 0;
  private nextKnownSessionSearchAt = 0;
  private knownSessionSearchDelayMs = 250;

  constructor(private readonly opts: CodexRolloutWatcherOptions) {
    this.home = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.startedAt = opts.startedAt ?? Date.now();
    this.pollMs = opts.pollMs ?? 250;
    this.discoveryMs = opts.discoveryMs ?? 2000;
    this.expectedSessionId = opts.sessionId ?? null;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
  }

  setSessionId(sessionId: string): void {
    if (this.expectedSessionId === sessionId || this.selected?.sessionId === sessionId) return;
    this.expectedSessionId = sessionId;
    this.knownSessionSearchDelayMs = 250;
    this.nextKnownSessionSearchAt = 0;
    if (this.selected) return;
    void this.closeCandidates();
    void this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.closeCandidates();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (this.selected) {
        if (Date.now() >= this.nextDiscoveryAt) {
          this.nextDiscoveryAt = Date.now() + this.discoveryMs;
          await this.discoverRecentSessions();
          for (const candidate of [...this.candidates.values()]) {
            if (candidate !== this.selected) await this.readCandidate(candidate);
          }
        }
        if (this.selected) await this.readCandidate(this.selected);
      } else if (this.expectedSessionId) {
        if (Date.now() < this.nextKnownSessionSearchAt) return;
        const retryMs = this.knownSessionSearchDelayMs;
        this.opts.log.debug({ terminal: this.opts.terminalName, sessionId: this.expectedSessionId, retryMs }, 'buscando rollout Codex pelo id');
        await this.findKnownSession();
        if (this.selected) {
          this.knownSessionSearchDelayMs = 250;
          this.nextKnownSessionSearchAt = 0;
          await this.readCandidate(this.selected);
        } else {
          this.nextKnownSessionSearchAt = Date.now() + retryMs;
          this.knownSessionSearchDelayMs = Math.min(retryMs * 2, 10_000);
        }
      } else {
        await this.discoverRecentSessions();
        for (const candidate of [...this.candidates.values()]) await this.readCandidate(candidate);
      }
    } catch (error) {
      this.opts.log.warn({ err: error, terminal: this.opts.terminalName }, 'falha ao acompanhar rollout Codex');
    } finally {
      this.polling = false;
    }
  }

  private async findKnownSession(): Promise<void> {
    const sessionsDir = join(this.home, 'sessions');
    for (const dayDir of await listSessionDays(sessionsDir)) {
      let names: string[];
      try { names = await readdir(dayDir); } catch { continue; }
      const filename = names.find((name) => name.startsWith('rollout-') && name.endsWith(`-${this.expectedSessionId}.jsonl`));
      if (!filename) continue;
      const path = join(dayDir, filename);
      const candidate = await this.openCandidate(path, true);
      if (!candidate) return;
      candidate.sessionId = this.expectedSessionId;
      candidate.selected = true;
      this.selected = candidate;
      this.candidates.set(path, candidate);
      this.emit({ kind: 'session', sessionId: candidate.sessionId! });
      this.opts.log.info({ terminal: this.opts.terminalName, sessionId: candidate.sessionId, rollout: path }, 'rollout Codex associado pelo ID');
      return;
    }
  }

  private async discoverRecentSessions(): Promise<void> {
    const sessionsDir = join(this.home, 'sessions');
    for (const dayDir of recentSessionDays(sessionsDir, this.startedAt)) {
      let names: string[];
      try { names = await readdir(dayDir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dayDir, name);
        if (this.candidates.has(path)) continue;
        let info;
        try { info = await stat(path); } catch { continue; }
        const createdAt = info.birthtimeMs || info.ctimeMs;
        if (createdAt < this.startedAt - 10_000) continue;
        const candidate = await this.openCandidate(path, false, true);
        if (candidate) this.candidates.set(path, candidate);
      }
    }
  }

  private async openCandidate(path: string, fromEnd: boolean, eligible = fromEnd): Promise<Candidate | null> {
    try {
      return {
        cursor: await RolloutCursor.open(path, fromEnd),
        sessionId: null,
        eligible,
        selected: false,
        pendingEvents: [],
      };
    } catch (error) {
      this.opts.log.debug({ err: error, terminal: this.opts.terminalName, rollout: path }, 'rollout Codex ainda indisponível');
      return null;
    }
  }

  private async readCandidate(candidate: Candidate): Promise<void> {
    const lines = await candidate.cursor.readLines();
    for (const line of lines) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const payload = asRecord(row.payload);
      if (row.type === 'session_meta') {
        const metadata = asRecord(row.payload);
        const id = firstString(metadata.id, metadata.session_id);
        if (!candidate.eligible && normalizePath(metadata.cwd) !== normalizePath(this.opts.cwd)) {
          await this.removeCandidate(candidate);
          return;
        }
        candidate.sessionId = id ?? candidate.sessionId ?? sessionIdFromFilename(candidate.cursor.path);
      }

      if (!candidate.selected && isTerminalDeveloperMessage(row, this.opts.terminalName)) {
        if (!candidate.eligible || !candidate.sessionId) continue;
        candidate.selected = true;
        this.selected = candidate;
        this.emit({ kind: 'session', sessionId: candidate.sessionId });
        for (const pending of candidate.pendingEvents) this.emit({ ...pending, sessionId: candidate.sessionId });
        candidate.pendingEvents = [];
        this.opts.log.info({ terminal: this.opts.terminalName, sessionId: candidate.sessionId, rollout: candidate.cursor.path }, 'rollout Codex associado por cwd e identidade');
        await this.closeOtherCandidates(candidate);
      }

      const event = parseEvent(row, payload);
      if (!event) continue;
      if (candidate.selected && candidate.sessionId) this.emit({ ...event, sessionId: candidate.sessionId });
      else if (candidate.eligible && candidate.pendingEvents.length < 256) candidate.pendingEvents.push(event);
    }
  }

  private emit(event: CodexRolloutEvent): void {
    if (this.stopped) return;
    this.opts.onEvent(event);
    if (event.kind !== 'session') this.opts.log.debug({ terminal: this.opts.terminalName, sessionId: event.sessionId, turnId: event.turnId, event: event.kind, ...(event.kind === 'turn-aborted' ? { reason: event.reason } : {}) }, 'evento do rollout Codex');
  }

  private async removeCandidate(candidate: Candidate): Promise<void> {
    this.candidates.delete(candidate.cursor.path);
    await candidate.cursor.close();
  }

  private async closeOtherCandidates(selected: Candidate): Promise<void> {
    for (const candidate of this.candidates.values()) {
      if (candidate !== selected) await candidate.cursor.close();
    }
    this.candidates.clear();
    this.candidates.set(selected.cursor.path, selected);
  }

  private async closeCandidates(): Promise<void> {
    const candidates = [...this.candidates.values()];
    this.candidates.clear();
    for (const candidate of candidates) await candidate.cursor.close();
    this.selected = null;
  }
}

function parseEvent(row: Record<string, unknown>, payload: Record<string, unknown>): ParsedRolloutEvent | null {
  const event = firstString(payload.type, row.type);
  const turnId = firstString(payload.turn_id, row.turn_id);
  if (!turnId) return null;
  if (event === 'task_started') return { kind: 'task-started', turnId };
  if (event === 'task_complete') return { kind: 'task-complete', turnId, answer: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null };
  if (event === 'turn_aborted') return { kind: 'turn-aborted', turnId, reason: typeof payload.reason === 'string' ? payload.reason : null };
  return null;
}

function isTerminalDeveloperMessage(row: Record<string, unknown>, terminalName: string): boolean {
  if (row.type !== 'response_item') return false;
  const payload = asRecord(row.payload);
  if (payload.type !== 'message' || payload.role !== 'developer' || !Array.isArray(payload.content)) return false;
  const marker = `Seu terminal se chama ${terminalName}.`;
  return payload.content.some((item) => markerIsPresent(asRecord(item).text, marker));
}

function markerIsPresent(value: unknown, marker: string): boolean {
  return typeof value === 'string' && value.includes(marker);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return resolve(value).replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
}

function sessionIdFromFilename(path: string): string | null {
  return basename(path).match(/^rollout-.+-([a-z0-9-]+)\.jsonl$/i)?.[1] ?? null;
}

async function listSessionDays(sessionsDir: string): Promise<string[]> {
  const days: string[] = [];
  let years: string[];
  try { years = await readdir(sessionsDir); } catch { return days; }
  for (const year of years) {
    let months: string[];
    try { months = await readdir(join(sessionsDir, year)); } catch { continue; }
    for (const month of months) {
      let dates: string[];
      try { dates = await readdir(join(sessionsDir, year, month)); } catch { continue; }
      for (const date of dates) days.push(join(sessionsDir, year, month, date));
    }
  }
  return days;
}

function recentSessionDays(sessionsDir: string, timestamp: number): string[] {
  const days: string[] = [];
  for (let offset = 0; offset <= 1; offset++) {
    const date = new Date(timestamp);
    date.setDate(date.getDate() - offset);
    days.push(join(sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')));
  }
  return days;
}
