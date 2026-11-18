import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '@orquestra/core';
import {
  REMOTE_PAIR_RATE_LIMIT,
  REMOTE_PAIR_RATE_WINDOW_MS,
  REMOTE_PAIR_TTL_MS,
  type RemoteDevice,
} from '@orquestra/shared';

const storedDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
type StoredDevice = z.infer<typeof storedDeviceSchema>;

const devicesFileSchema = z.object({
  version: z.literal(1),
  devices: z.array(storedDeviceSchema),
});

const stateFileSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
});

type PairingEntry = {
  id: string;
  tokenHash: Buffer;
  expiresAt: number;
};

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return sha256Buffer(value).toString('hex');
}

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

export type RemoteDeviceStoreOptions = {
  dataDir: string;
  log: Logger;
  now?: () => number;
  pairTtlMs?: number;
  rateLimit?: number;
  rateWindowMs?: number;
};

export class RemoteDeviceStore {
  private readonly devicesFile: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly pairTtlMs: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private devices: StoredDevice[] = [];
  private enabled = false;
  private readonly pairings = new Map<string, PairingEntry>();
  private readonly pairAttempts: number[] = [];

  constructor(private readonly opts: RemoteDeviceStoreOptions) {
    this.devicesFile = join(opts.dataDir, 'remote-devices.json');
    this.stateFile = join(opts.dataDir, 'remote-state.json');
    this.now = opts.now ?? (() => Date.now());
    this.pairTtlMs = opts.pairTtlMs ?? REMOTE_PAIR_TTL_MS;
    this.rateLimit = opts.rateLimit ?? REMOTE_PAIR_RATE_LIMIT;
    this.rateWindowMs = opts.rateWindowMs ?? REMOTE_PAIR_RATE_WINDOW_MS;
    this.load();
  }

  private load(): void {
    if (existsSync(this.devicesFile)) {
      try {
        const parsed = devicesFileSchema.parse(JSON.parse(readFileSync(this.devicesFile, 'utf8')));
        this.devices = parsed.devices;
      } catch (error) {
        this.opts.log.warn({ err: error, file: this.devicesFile }, 'lista de dispositivos remotos inválida; iniciando vazia');
        this.devices = [];
      }
    }
    if (existsSync(this.stateFile)) {
      try {
        const parsed = stateFileSchema.parse(JSON.parse(readFileSync(this.stateFile, 'utf8')));
        this.enabled = parsed.enabled;
      } catch (error) {
        this.opts.log.warn({ err: error, file: this.stateFile }, 'estado do acesso remoto inválido; iniciando desligado');
        this.enabled = false;
      }
    }
  }

  private saveDevices(): void {
    writeAtomic(this.devicesFile, { version: 1, devices: this.devices });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    writeAtomic(this.stateFile, { version: 1, enabled });
  }

  list(): RemoteDevice[] {
    return this.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }));
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== id);
    if (this.devices.length === before) return false;
    this.saveDevices();
    return true;
  }

  createPairing(): { token: string; expiresAt: string } {
    const current = this.now();
    this.prunePairings(current);
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = current + this.pairTtlMs;
    const id = randomUUID();
    this.pairings.set(id, { id, tokenHash: sha256Buffer(token), expiresAt: expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private prunePairings(current: number): void {
    for (const [id, entry] of this.pairings) {
      if (entry.expiresAt <= current) this.pairings.delete(id);
    }
  }

  private allowPairAttempt(current: number): boolean {
    const cutoff = current - this.rateWindowMs;
    while (this.pairAttempts.length > 0 && this.pairAttempts[0]! <= cutoff) {
      this.pairAttempts.shift();
    }
    if (this.pairAttempts.length >= this.rateLimit) return false;
    this.pairAttempts.push(current);
    return true;
  }

  redeemPairing(pairToken: string, deviceName: string): { ok: true; deviceToken: string; device: RemoteDevice } | { ok: false; reason: 'rate_limit' | 'invalid' } {
    const current = this.now();
    if (!this.allowPairAttempt(current)) return { ok: false, reason: 'rate_limit' };
    this.prunePairings(current);
    const incomingHash = sha256Buffer(pairToken);
    let matchedId: string | null = null;
    // Percorre todas as entradas ativas para manter comparação em tempo constante.
    for (const [id, entry] of this.pairings) {
      if (timingSafeEqual(entry.tokenHash, incomingHash) && matchedId === null) {
        matchedId = id;
      }
    }
    if (!matchedId) return { ok: false, reason: 'invalid' };
    this.pairings.delete(matchedId);
    const deviceToken = randomBytes(32).toString('base64url');
    const nowIso = new Date(current).toISOString();
    const stored: StoredDevice = {
      id: randomUUID(),
      name: deviceName,
      tokenHash: sha256Hex(deviceToken),
      createdAt: nowIso,
      lastSeenAt: null,
    };
    this.devices.push(stored);
    this.saveDevices();
    return {
      ok: true,
      deviceToken,
      device: { id: stored.id, name: stored.name, createdAt: stored.createdAt, lastSeenAt: stored.lastSeenAt },
    };
  }

  authenticate(token: string): RemoteDevice | null {
    if (!token) return null;
    const incomingHash = sha256Buffer(token);
    let matched: StoredDevice | null = null;
    for (const device of this.devices) {
      const storedHash = Buffer.from(device.tokenHash, 'hex');
      if (storedHash.length === incomingHash.length && timingSafeEqual(storedHash, incomingHash) && matched === null) {
        matched = device;
      }
    }
    if (!matched) return null;
    matched.lastSeenAt = new Date(this.now()).toISOString();
    try {
      this.saveDevices();
    } catch (error) {
      this.opts.log.warn({ err: error, deviceId: matched.id }, 'falha ao gravar último acesso do dispositivo');
    }
    return { id: matched.id, name: matched.name, createdAt: matched.createdAt, lastSeenAt: matched.lastSeenAt };
  }
}
