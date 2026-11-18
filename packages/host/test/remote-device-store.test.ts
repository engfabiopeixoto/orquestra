import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../core/src/log.js';
import { RemoteDeviceStore } from '../src/remote/device-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orq-remote-store-'));
  dirs.push(dir);
  return dir;
}

describe('RemoteDeviceStore', () => {
  it('grava apenas o hash SHA-256 no disco, nunca o token em texto puro', () => {
    const dataDir = makeDir();
    let clock = 1_000_000;
    const store = new RemoteDeviceStore({ dataDir, log: silentLogger(), now: () => clock });
    const pair = store.createPairing();
    const redeemed = store.redeemPairing(pair.token, 'Pixel do Usuário');
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    const rawFile = readFileSync(join(dataDir, 'remote-devices.json'), 'utf8');
    expect(rawFile).not.toContain(redeemed.deviceToken);
    expect(rawFile).not.toContain(pair.token);

    const expectedHash = createHash('sha256').update(redeemed.deviceToken, 'utf8').digest('hex');
    const parsed = JSON.parse(rawFile) as { devices: Array<{ tokenHash: string; name: string }> };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]!.tokenHash).toBe(expectedHash);
    expect(parsed.devices[0]!.name).toBe('Pixel do Usuário');

    const reloaded = new RemoteDeviceStore({ dataDir, log: silentLogger(), now: () => clock + 5000 });
    expect(reloaded.authenticate(redeemed.deviceToken)?.id).toBe(redeemed.device.id);
    expect(reloaded.authenticate('token-errado')).toBeNull();
  });

  it('pareamento é de uso único e expira após o TTL', () => {
    const dataDir = makeDir();
    let clock = 1_000_000;
    const store = new RemoteDeviceStore({ dataDir, log: silentLogger(), now: () => clock, pairTtlMs: 5000 });

    const pair1 = store.createPairing();
    const first = store.redeemPairing(pair1.token, 'Celular A');
    expect(first.ok).toBe(true);
    const second = store.redeemPairing(pair1.token, 'Celular B');
    expect(second).toEqual({ ok: false, reason: 'invalid' });

    const pair2 = store.createPairing();
    clock += 5001;
    const expired = store.redeemPairing(pair2.token, 'Celular C');
    expect(expired).toEqual({ ok: false, reason: 'invalid' });
  });

  it('aplica rate limit de pareamento (5 tentativas por minuto)', () => {
    const dataDir = makeDir();
    let clock = 1_000_000;
    const store = new RemoteDeviceStore({ dataDir, log: silentLogger(), now: () => clock, rateLimit: 5, rateWindowMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      expect(store.redeemPairing('invalido', 'Dev')).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(store.redeemPairing('invalido', 'Dev')).toEqual({ ok: false, reason: 'rate_limit' });

    clock += 60_001;
    const pair = store.createPairing();
    expect(store.redeemPairing(pair.token, 'Dev')).toMatchObject({ ok: true });
  });

  it('revoga dispositivo e persiste estado ligado/desligado', () => {
    const dataDir = makeDir();
    const store = new RemoteDeviceStore({ dataDir, log: silentLogger() });
    expect(store.isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(new RemoteDeviceStore({ dataDir, log: silentLogger() }).isEnabled()).toBe(true);

    const pair = store.createPairing();
    const res = store.redeemPairing(pair.token, 'iPhone');
    if (!res.ok) throw new Error('falha esperada');
    expect(store.authenticate(res.deviceToken)).not.toBeNull();
    expect(store.revoke(res.device.id)).toBe(true);
    expect(store.authenticate(res.deviceToken)).toBeNull();
    expect(store.revoke('nao-existe')).toBe(false);
  });
});
