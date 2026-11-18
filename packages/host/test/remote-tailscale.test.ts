import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { silentLogger } from '../../core/src/log.js';
import {
  RemoteGateway,
  resolveTailscaleExecutable,
  TAILSCALE_WIN_EXE,
  TailscaleServeManager,
} from '../src/remote/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('TailscaleServeManager', () => {
  it('acha o executável no PATH ou em C:/Program Files/Tailscale/tailscale.exe', async () => {
    const fromPath = await resolveTailscaleExecutable({
      env: { PATH: 'C:\\Tools;C:\\TailscaleBin' },
      fileExists: (p) => p.replaceAll('\\', '/') === 'C:/TailscaleBin/tailscale.exe',
    });
    expect(fromPath?.replaceAll('\\', '/')).toBe('C:/TailscaleBin/tailscale.exe');

    const fromProgramFiles = await resolveTailscaleExecutable({
      env: { PATH: 'C:\\Tools' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => {
        throw new Error('where falhou');
      },
    });
    expect(fromProgramFiles).toBe(TAILSCALE_WIN_EXE);

    const missing = await resolveTailscaleExecutable({
      env: { PATH: '' },
      fileExists: () => false,
      runner: async () => ({ stdout: '', stderr: '' }),
    });
    expect(missing).toBeNull();
  });

  it('prioriza TAILSCALE_WIN_EXE antes do PATH, ignora diretórios relativos no PATH e usa System32/where.exe com $PATH:tailscale.exe', async () => {
    const hijackPath = 'C:\\EvilBin\\tailscale.exe';
    const preferred = await resolveTailscaleExecutable({
      env: { PATH: 'C:\\EvilBin;relative\\bin' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE || p.replaceAll('\\', '/') === 'C:/EvilBin/tailscale.exe',
    });
    expect(preferred).toBe(TAILSCALE_WIN_EXE);
    expect(preferred).not.toBe(hijackPath);

    // Ignora entradas relativas no PATH mesmo quando TAILSCALE_WIN_EXE não existe
    const whereCalls: Array<[string, string[]]> = [];
    const fromWhere = await resolveTailscaleExecutable({
      env: { PATH: 'relative\\bin;.\\local', SystemRoot: 'C:\\Windows' },
      fileExists: (p) => p.replaceAll('\\', '/') === 'C:/Program Files/Custom/tailscale.exe',
      runner: async (file, args) => {
        whereCalls.push([file, args]);
        return { stdout: 'C:\\Program Files\\Custom\\tailscale.exe\r\n', stderr: '' };
      },
    });
    expect(fromWhere?.replaceAll('\\', '/')).toBe('C:/Program Files/Custom/tailscale.exe');
    expect(whereCalls).toEqual([['C:\\Windows\\System32\\where.exe', ['$PATH:tailscale.exe']]]);
  });

  it('normaliza DNSName para minúsculas e rejeita hostnames inválidos', async () => {
    const manager = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async (_file, args) => {
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'Desktop-RVG8ANT.Tail9938E7.ts.net.' },
              CertDomains: ['desktop-rvg8ant.tail9938e7.ts.net'],
              TailscaleIPs: ['100.113.98.14'],
            }),
            stderr: '',
          };
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    const ok = await manager.startServe(47820);
    expect(ok).toMatchObject({
      state: 'serving',
      dnsName: 'desktop-rvg8ant.tail9938e7.ts.net',
      url: 'https://desktop-rvg8ant.tail9938e7.ts.net:8443',
    });

    const invalidHost = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => ({
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'bad_host/evil' },
          CertDomains: ['bad.ts.net'],
          TailscaleIPs: ['100.113.98.14'],
        }),
        stderr: '',
      }),
    });
    const bad = await invalidHost.startServe(47820);
    expect(bad.state).toBe('error');
    expect(bad.dnsName).toBeNull();
  });

  it('ativa o serve em --https=8443, remove o ponto final do DNSName e no stopServe remove só a regra 8443 (nunca serve reset)', async () => {
    const calls: Array<[string, string[]]> = [];
    const manager = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async (file, args) => {
        calls.push([file, args]);
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'meu-pc.tail9938e7.ts.net.' },
              CertDomains: ['meu-pc.tail9938e7.ts.net'],
              TailscaleIPs: ['100.113.98.14', 'fd7a:115c:a1e0::1'],
            }),
            stderr: '',
          };
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    const status = await manager.startServe(47820);
    expect(status).toEqual({
      state: 'serving',
      dnsName: 'meu-pc.tail9938e7.ts.net',
      url: 'https://meu-pc.tail9938e7.ts.net:8443',
      error: null,
      tailscaleIp: '100.113.98.14',
    });
    expect(calls).toContainEqual([
      TAILSCALE_WIN_EXE,
      ['serve', '--bg', '--https=8443', 'http://127.0.0.1:47820'],
    ]);

    await manager.stopServe();
    expect(calls.at(-1)).toEqual([
      TAILSCALE_WIN_EXE,
      ['serve', '--https=8443', 'off'],
    ]);
    expect(calls.some(([, a]) => a.includes('reset'))).toBe(false);
  });

  it('devolve motivo em pt-BR quando sem tailscale, deslogado ou sem CertDomains/HTTPS', async () => {
    const noExe = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: () => false,
      runner: async () => ({ stdout: '', stderr: '' }),
    });
    const r1 = await noExe.startServe(47820);
    expect(r1.state).toBe('error');
    expect(r1.error).toContain('Tailscale não encontrado');

    const loggedOut = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => ({
        stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' }, TailscaleIPs: [] }),
        stderr: '',
      }),
    });
    const r2 = await loggedOut.startServe(47820);
    expect(r2.state).toBe('error');
    expect(r2.error).toContain('Faça login');

    const noHttps = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => ({
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'meu-pc.tailnet.ts.net.' },
          CertDomains: [],
          TailscaleIPs: ['100.90.10.5'],
        }),
        stderr: '',
      }),
    });
    const r3 = await noHttps.startServe(47820);
    expect(r3).toMatchObject({
      state: 'error',
      dnsName: 'meu-pc.tailnet.ts.net',
      url: null,
      tailscaleIp: '100.90.10.5',
    });
    expect(r3.error).toContain('HTTPS');
    expect(r3.error).toContain('plano B');
  });
});

describe('RemoteGateway + Tailscale e Plano B', () => {
  it('usa a URL https do Tailscale no pareamento, libera sua Origin no gateway e remove a regra ao desligar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-ts-gw-'));
    const mobileDir = join(dataDir, 'mobile');
    mkdirSync(mobileDir, { recursive: true });
    writeFileSync(join(mobileDir, 'index.html'), '<html><body>OK</body></html>');

    const serveCalls: string[][] = [];
    const tailscale = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async (_file, args) => {
        serveCalls.push(args);
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'pc-fabio.tailnet.ts.net.' },
              CertDomains: ['pc-fabio.tailnet.ts.net'],
              TailscaleIPs: ['100.100.50.25'],
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    });

    const gateway = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale,
    });
    cleanups.push(async () => {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const status = await gateway.enable(true);
    expect(status.tailscale).toEqual({
      state: 'serving',
      dnsName: 'pc-fabio.tailnet.ts.net',
      url: 'https://pc-fabio.tailnet.ts.net:8443',
      error: null,
      tailscaleIp: '100.100.50.25',
    });

    const pair = gateway.pair();
    expect(pair.url).toBe(`https://pc-fabio.tailnet.ts.net:8443/?pair=${encodeURIComponent(pair.token)}`);

    // Origin da URL do Tailscale é aceita no pareamento HTTP e no WebSocket
    const pairRes = await fetch(`${status.localUrl}/api/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://pc-fabio.tailnet.ts.net:8443',
      },
      body: JSON.stringify({ pairToken: pair.token, deviceName: 'Celular Tailscale' }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const ws = new WebSocket(`${status.localUrl.replace(/^http/, 'ws')}/ws`, {
      headers: { Origin: 'https://pc-fabio.tailnet.ts.net:8443' },
    });
    await new Promise<void>((r, reject) => {
      ws.once('open', () => r());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: deviceToken }));
    ws.close();

    await gateway.enable(false);
    expect(serveCalls.at(-1)).toEqual(['serve', '--https=8443', 'off']);
  });

  it('oferece e ativa o plano B (HTTP no IP 100.x do Tailscale) quando o tailscale serve falha', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-ts-fb-'));
    const mobileDir = join(dataDir, 'mobile');
    mkdirSync(mobileDir, { recursive: true });
    writeFileSync(join(mobileDir, 'index.html'), '<html><body>OK</body></html>');

    const tailscale = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => ({
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'pc-fabio.tailnet.ts.net.' },
          CertDomains: [],
          TailscaleIPs: ['100.100.50.25'],
        }),
        stderr: '',
      }),
    });

    const gateway = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale,
      fallbackBindHost: '127.0.0.1',
    });
    cleanups.push(async () => {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const initial = await gateway.enable(true);
    expect(initial.tailscale?.state).toBe('error');
    expect(initial.tailscale?.tailscaleIp).toBe('100.100.50.25');

    // Agora o gateway já está ouvindo em 127.0.0.1:porta; testamos o plano B em 127.0.0.2 (loopback secundário)
    const gatewayFb = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale,
      fallbackBindHost: '127.0.0.2',
    });
    cleanups.push(() => gatewayFb.close());

    const fbStatus = await gatewayFb.enable(true, { fallbackHttp: true });
    expect(fbStatus.tailscale?.state).toBe('fallback');
    expect(fbStatus.tailscale?.url).toBe(`http://100.100.50.25:${fbStatus.port}`);

    const pair = gatewayFb.pair();
    expect(pair.url).toBe(`http://100.100.50.25:${fbStatus.port}/?pair=${encodeURIComponent(pair.token)}`);

    const res = await fetch(`http://127.0.0.2:${fbStatus.port}/api/health`);
    expect(res.status).toBe(200);

    // Origin http://<tailscaleIp>:<port> é aceita no plano B (POST /api/pair e /ws)
    const fbPair = gatewayFb.pair();
    const fbPairRes = await fetch(`http://127.0.0.2:${fbStatus.port}/api/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://100.100.50.25:${fbStatus.port}`,
      },
      body: JSON.stringify({ pairToken: fbPair.token, deviceName: 'Celular Plano B' }),
    });
    expect(fbPairRes.status).toBe(200);
    const { deviceToken: fbToken } = (await fbPairRes.json()) as { deviceToken: string };

    const fbWs = new WebSocket(`ws://127.0.0.2:${fbStatus.port}/ws`, {
      headers: { Origin: `http://100.100.50.25:${fbStatus.port}` },
    });
    await new Promise<void>((r, reject) => {
      fbWs.once('open', () => r());
      fbWs.once('error', reject);
    });
    fbWs.send(JSON.stringify({ type: 'auth', token: fbToken }));
    fbWs.close();
  });

  it('não aceita Origin do IP 100.x fora do plano B e recusa plano B sem tailscaleIp ou com bindHost público/LAN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-ts-strict-'));
    const mobileDir = join(dataDir, 'mobile');
    mkdirSync(mobileDir, { recursive: true });
    writeFileSync(join(mobileDir, 'index.html'), '<html><body>OK</body></html>');

    const servingTs = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async (_file, args) => {
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'pc-fabio.tailnet.ts.net.' },
              CertDomains: ['pc-fabio.tailnet.ts.net'],
              TailscaleIPs: ['100.100.50.25'],
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    });

    const gateway = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale: servingTs,
    });
    cleanups.push(async () => {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const status = await gateway.enable(true);
    const pair = gateway.pair();
    const deniedPair = await fetch(`${status.localUrl}/api/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://100.100.50.25:${status.port}`,
      },
      body: JSON.stringify({ pairToken: pair.token, deviceName: 'Invasor' }),
    });
    expect(deniedPair.status).toBe(403);

    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${status.localUrl.replace(/^http/, 'ws')}/ws`, {
          headers: { Origin: `http://100.100.50.25:${status.port}` },
        });
        ws.once('open', () => {
          ws.close();
          reject(new Error('deveria ter recusado o handshake'));
        });
        ws.once('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(403);
          resolve();
        });
        ws.once('error', () => resolve());
      }),
    ).resolves.toBeUndefined();

    // Sem tailscaleIp => recusa enable(true, { fallbackHttp: true })
    const noIpTs = new TailscaleServeManager({
      env: { PATH: '' },
      fileExists: (p) => p === TAILSCALE_WIN_EXE,
      runner: async () => ({
        stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: '' }, TailscaleIPs: [] }),
        stderr: '',
      }),
    });
    const gwNoIp = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale: noIpTs,
    });
    cleanups.push(() => gwNoIp.close());
    await expect(gwNoIp.enable(true, { fallbackHttp: true })).rejects.toThrow(/IP 100\.x/);

    // fallbackBindHost 0.0.0.0 ou IP LAN => recusa
    for (const badHost of ['0.0.0.0', '192.168.1.25']) {
      const gwBadHost = new RemoteGateway({
        dataDir,
        log: silentLogger(),
        electronSend: () => {},
        port: 0,
        mobileDir,
        tailscale: servingTs,
        fallbackBindHost: badHost,
      });
      cleanups.push(() => gwBadHost.close());
      await expect(gwBadHost.enable(true, { fallbackHttp: true })).rejects.toThrow(/não permitido/);
    }
  });

  it('ao fechar o app (close) remove a regra 8443 preservando store.isEnabled() e init() recria ao reabrir; close com gateway desligado não chama stopServe', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-ts-reopen-'));
    const mobileDir = join(dataDir, 'mobile');
    mkdirSync(mobileDir, { recursive: true });
    writeFileSync(join(mobileDir, 'index.html'), '<html><body>OK</body></html>');

    const calls: string[][] = [];
    const makeTs = () =>
      new TailscaleServeManager({
        env: { PATH: '' },
        fileExists: (p) => p === TAILSCALE_WIN_EXE,
        runner: async (_file, args) => {
          calls.push(args);
          if (args[0] === 'status') {
            return {
              stdout: JSON.stringify({
                BackendState: 'Running',
                Self: { DNSName: 'pc-fabio.tailnet.ts.net.' },
                CertDomains: ['pc-fabio.tailnet.ts.net'],
                TailscaleIPs: ['100.100.50.25'],
              }),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      });

    // Gateway nunca ligado: close() não deve chamar tailscale serve off
    const idleGw = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale: makeTs(),
    });
    await idleGw.close();
    expect(calls).toHaveLength(0);

    const gw1 = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale: makeTs(),
    });
    cleanups.push(async () => {
      await gw1.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await gw1.enable(true);
    expect(gw1.store.isEnabled()).toBe(true);
    expect(calls.some((a) => a[0] === 'serve' && a[1] === '--bg' && a[2] === '--https=8443')).toBe(true);

    calls.length = 0;
    await gw1.close();
    expect(calls).toEqual([['serve', '--https=8443', 'off']]);
    expect(gw1.store.isEnabled()).toBe(true);

    // Reabertura do app: init() deve religar o gateway e recriar a regra 8443
    calls.length = 0;
    const gw2 = new RemoteGateway({
      dataDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      mobileDir,
      tailscale: makeTs(),
    });
    cleanups.push(() => gw2.close());

    await gw2.init();
    expect(gw2.status().enabled).toBe(true);
    expect(gw2.status().tailscale?.state).toBe('serving');
    expect(calls.some((a) => a[0] === 'serve' && a[1] === '--bg' && a[2] === '--https=8443')).toBe(true);
  });
});
