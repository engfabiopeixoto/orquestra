import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
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
  terminalId: string;
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

  async readFirstLine(): Promise<string | null> {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return null;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    return null;
  }

  async readTerminalId(): Promise<string | null> {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return null;
      const lines = Buffer.concat([...chunks, buffer.subarray(0, bytesRead)]).toString('utf8').split('\n');
      const pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const id = terminalIdentity(JSON.parse(line.replace(/\r$/, '')) as Record<string, unknown>);
          if (id) return id;
        } catch { /* Linhas incompletas ou registros não JSON são ignorados. */ }
      }
      chunks.length = 0;
      if (pending) chunks.push(Buffer.from(pending, 'utf8'));
      position += bytesRead;
    }
    return null;
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }
}

type Candidate = {
  cursor: RolloutCursor;
  sessionId: string | null;
  cwd: string | null;
  rolloutTimestamp: number | null;
  eligible: boolean;
  selected: boolean;
  pendingEvents: Array<{ kind: 'task-started'; turnId: string } | { kind: 'task-complete'; turnId: string; answer: string | null } | { kind: 'turn-aborted'; turnId: string; reason: string | null }>;
};

/** Valida cwd sempre e o id terminal quando o rollout já tem a marcação estável. */
export function codexRolloutMatchesTerminal(sessionId: string, cwd: string, terminalId: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): boolean | null {
  const sessionsDir = join(codexHome, 'sessions');
  let years;
  try { years = readdirSync(sessionsDir, { withFileTypes: true }); } catch { return null; }
  for (const year of years) {
    if (!year.isDirectory()) continue;
    let months;
    try { months = readdirSync(join(sessionsDir, year.name), { withFileTypes: true }); } catch { continue; }
    for (const month of months) {
      if (!month.isDirectory()) continue;
      let days;
      try { days = readdirSync(join(sessionsDir, year.name, month.name), { withFileTypes: true }); } catch { continue; }
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayPath = join(sessionsDir, year.name, month.name, day.name);
        let files;
        try { files = readdirSync(dayPath); } catch { continue; }
        const filename = files.find((name) => name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`));
        if (!filename) continue;
        let descriptor: number | undefined;
        try {
          descriptor = openSync(join(dayPath, filename), 'r');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
          const firstLine = buffer.subarray(0, newline >= 0 ? newline : bytesRead).toString('utf8').replace(/\r$/, '');
          const row = JSON.parse(firstLine) as Record<string, unknown>;
          if (normalizePath(asRecord(row.payload).cwd) !== normalizePath(cwd)) return false;
          const identity = readTerminalIdentitySync(descriptor);
          return identity === null || identity === terminalId;
        } catch {
          return false;
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
      }
    }
  }
  return null;
}

function readTerminalIdentitySync(descriptor: number): string | null {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
  for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
    try {
      const identity = terminalIdentity(JSON.parse(line.replace(/\r$/, '')) as Record<string, unknown>);
      if (identity) return identity;
    } catch { /* Registro parcial ignorado. */ }
  }
  return null;
}

/** Associa a thread pelo ID ou pelo cwd e a identidade que o Codex registra em response_item/developer. */
export class CodexRolloutWatcher {
  private readonly home: string;
  private readonly startedAt: number;
  private readonly pollMs: number;
  private readonly discoveryMs: number;
  private readonly candidates = new Map<string, Candidate>();
  private readonly olderRollouts = new Set<string>();
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
          if (Date.now() >= this.nextDiscoveryAt) {
            this.nextDiscoveryAt = Date.now() + this.discoveryMs;
            await this.discoverRecentSessions();
            for (const candidate of [...this.candidates.values()]) await this.readCandidate(candidate);
          }
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
      const existing = this.candidates.get(path);
      if (existing) {
        await this.readCandidate(existing);
        return;
      }
      const candidate = await this.openCandidate(path, true);
      if (!candidate) return;
      candidate.sessionId = this.expectedSessionId;
      const firstLine = await candidate.cursor.readFirstLine();
      if (firstLine) {
        try {
          const row = JSON.parse(firstLine) as Record<string, unknown>;
          const metadata = asRecord(row.payload);
          candidate.rolloutTimestamp = timestampValue(row.timestamp) ?? timestampValue(metadata.timestamp) ?? candidate.rolloutTimestamp;
          candidate.cwd = normalizePath(metadata.cwd);
        } catch { /* O timestamp do nome do arquivo permanece como fallback. */ }
      }
      if (candidate.cwd !== normalizePath(this.opts.cwd)) {
        this.opts.log.warn({ terminal: this.opts.terminalName, terminalId: this.opts.terminalId, sessionId: candidate.sessionId, terminalCwd: this.opts.cwd, rolloutCwd: candidate.cwd, rollout: path }, 'rollout Codex ignorado: cwd não corresponde ao terminal');
        await candidate.cursor.close();
        return;
      }
      const rolloutTerminalId = await candidate.cursor.readTerminalId();
      if (rolloutTerminalId && rolloutTerminalId !== this.opts.terminalId) {
        this.opts.log.warn({ terminal: this.opts.terminalName, terminalId: this.opts.terminalId, rolloutTerminalId, sessionId: candidate.sessionId, cwd: candidate.cwd, rollout: path }, 'rollout Codex ignorado: id do terminal não corresponde');
        await candidate.cursor.close();
        return;
      }
      candidate.selected = true;
      this.selected = candidate;
      this.candidates.set(path, candidate);
      this.emit({ kind: 'session', sessionId: candidate.sessionId! });
      this.opts.log.info({ terminal: this.opts.terminalName, terminalId: this.opts.terminalId, cwd: candidate.cwd, sessionId: candidate.sessionId, rollout: path }, 'rollout Codex associado pelo ID e cwd');
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
        if (this.candidates.has(path) || this.olderRollouts.has(path)) continue;
        let info;
        try { info = await stat(path); } catch { continue; }
        const createdAt = info.birthtimeMs || info.ctimeMs;
        if (createdAt < this.startedAt - 10_000) continue;
        const candidate = await this.openCandidate(path, false);
        if (candidate) this.candidates.set(path, candidate);
      }
    }
  }

  private async openCandidate(path: string, fromEnd: boolean, eligible = fromEnd): Promise<Candidate | null> {
    try {
      return {
        cursor: await RolloutCursor.open(path, fromEnd),
        sessionId: null,
        cwd: null,
        rolloutTimestamp: rolloutTimestampFromPath(path),
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
        candidate.rolloutTimestamp = timestampValue(row.timestamp) ?? timestampValue(metadata.timestamp) ?? candidate.rolloutTimestamp;
        candidate.cwd = normalizePath(metadata.cwd);
        if (candidate.cwd !== normalizePath(this.opts.cwd)) {
          this.olderRollouts.add(candidate.cursor.path);
          await this.removeCandidate(candidate);
          return;
        }
        candidate.eligible = true;
        candidate.sessionId = id ?? candidate.sessionId ?? sessionIdFromFilename(candidate.cursor.path);
      }

      if (!candidate.selected && isDeveloperMessage(row)) {
        const candidateTerminalId = terminalIdentity(row);
        if (candidateTerminalId && candidateTerminalId !== this.opts.terminalId) {
          this.olderRollouts.add(candidate.cursor.path);
          await this.removeCandidate(candidate);
          return;
        }
        if (candidateTerminalId !== this.opts.terminalId) continue;
        if (!candidate.eligible || !candidate.sessionId) continue;
        if (this.selected && !isNewerRollout(candidate.rolloutTimestamp, this.selected.rolloutTimestamp)) {
          this.olderRollouts.add(candidate.cursor.path);
          await this.removeCandidate(candidate);
          return;
        }
        candidate.selected = true;
        this.selected = candidate;
        this.emit({ kind: 'session', sessionId: candidate.sessionId });
        for (const pending of candidate.pendingEvents) this.emit({ ...pending, sessionId: candidate.sessionId });
        candidate.pendingEvents = [];
        this.opts.log.info({ terminal: this.opts.terminalName, terminalId: this.opts.terminalId, cwd: candidate.cwd, sessionId: candidate.sessionId, rollout: candidate.cursor.path }, 'rollout Codex associado por cwd e identidade');
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

function isDeveloperMessage(row: Record<string, unknown>): boolean {
  const payload = asRecord(row.payload);
  return row.type === 'response_item' && payload.type === 'message' && payload.role === 'developer' && Array.isArray(payload.content);
}

function terminalIdentity(row: Record<string, unknown>): string | null {
  if (!isDeveloperMessage(row)) return null;
  const payload = asRecord(row.payload);
  for (const item of payload.content as unknown[]) {
    const text = asRecord(item).text;
    if (typeof text !== 'string') continue;
    const match = text.match(/Identificador do terminal no Orquestra: ([^\s.]+)\./);
    if (match) return match[1] ?? null;
  }
  return null;
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

function rolloutTimestampFromPath(path: string): number | null {
  const match = basename(path).match(/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!match) return null;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isNewerRollout(candidate: number | null, selected: number | null): boolean {
  return candidate !== null && selected !== null && candidate > selected;
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
