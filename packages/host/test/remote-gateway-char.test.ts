import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuildBundle } from 'esbuild';
import type { HostToMain } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { silentLogger } from '../../core/src/log.js';
import type { HostBridge } from '../src/bridge.js';
import { isAllowedBindHost, RemoteGateway } from '../src/remote/gateway.js';
import { defaultMobileDir } from '../src/remote/gateway/http.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function rawHttpGet(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function openAuthedWs(gateway: RemoteGateway, portUrl: string, origin?: string) {
  const pair = gateway.pair();
  const redeemed = gateway.store.redeemPairing(pair.token, 'Celular');
  if (!redeemed.ok) throw new Error('Falha ao parear no teste');
  const wsUrl = portUrl.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, origin ? { headers: { Origin: origin } } : undefined);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitMsg = () => new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
  });
  ws.send(JSON.stringify({ type: 'auth', token: redeemed.deviceToken }));
  const authReply = await waitMsg();
  expect(authReply.type).toBe('auth-ok');
  return { ws, waitMsg, device: redeemed.device };
}

describe('RemoteGateway: caracterização antes da modularização', () => {
  it('host-relay: remote.devices, remote.pair desligado, remote.revoke inexistente, remote.desconhecido e dispatchForTest', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-gw-char-'));
    const sent: HostToMain[] = [];
    const gw = new RemoteGateway({ dataDir, log: silentLogger(), electronSend: (m) => sent.push(m), port: 0, host: '127.0.0.1' });
    let closeCalled = false;
    const fakeInner: HostBridge = {
      handle: async () => {},
      dispatchForTest: async (method, params) => ({ echoed: method, params }),
      close: async () => { closeCalled = true; },
    };
    const wrapped = gw.wrapBridge(fakeInner);
    cleanups.push(async () => {
      await wrapped.close();
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    });

    await wrapped.handle({ kind: 'command', id: 'c-pair-off', method: 'remote.pair', params: {} });
    expect(sent.find((m) => m.kind === 'response-error' && m.id === 'c-pair-off')).toMatchObject({
      kind: 'response-error',
      error: { code: 'USAGE', message: 'Ligue o acesso remoto antes de gerar um link de pareamento.' },
    });

    await wrapped.handle({ kind: 'command', id: 'c-dev', method: 'remote.devices', params: {} });
    expect(sent.find((m) => m.kind === 'response' && m.id === 'c-dev')).toMatchObject({
      kind: 'response',
      ok: true,
      result: { devices: [] },
    });

    await wrapped.handle({ kind: 'command', id: 'c-rev', method: 'remote.revoke', params: { id: 'inexistente' } });
    expect(sent.find((m) => m.kind === 'response-error' && m.id === 'c-rev')).toMatchObject({
      kind: 'response-error',
      error: { code: 'NOT_FOUND', message: 'Dispositivo não encontrado.' },
    });

    await wrapped.handle({ kind: 'command', id: 'c-unk', method: 'remote.desconhecido', params: {} });
    expect(sent.find((m) => m.kind === 'response-error' && m.id === 'c-unk')).toMatchObject({
      kind: 'response-error',
      error: { code: 'USAGE', message: 'Comando remoto desconhecido: remote.desconhecido.' },
    });

    expect(await wrapped.dispatchForTest('whoami', {}, { session: 'A' })).toEqual({ echoed: 'whoami', params: {} });
    await wrapped.close();
    expect(closeCalled).toBe(true);
  });

  it('http: build ausente retorna 503, /api/* inexistente retorna 404, e Cache-Control diferencia sw.js de .js', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-gw-char-http-'));
    const missingMobileDir = join(dataDir, 'nao-existe');
    const gwMissing = new RemoteGateway({
      dataDir: join(dataDir, 'd1'),
      mobileDir: missingMobileDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      host: '127.0.0.1',
    });
    cleanups.push(async () => { await gwMissing.close(); try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });

    const s1 = await gwMissing.enable(true);
    const res503 = await rawHttpGet(`${s1.localUrl}/`);
    expect(res503.status).toBe(503);
    expect(res503.body).toBe('Build do aplicativo móvel não encontrado.');

    const res404 = await rawHttpGet(`${s1.localUrl}/api/desconhecida`);
    expect(res404.status).toBe(404);
    expect(JSON.parse(res404.body)).toEqual({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });

    const mobileDir = join(dataDir, 'dist');
    mkdirSync(join(mobileDir, 'assets'), { recursive: true });
    writeFileSync(join(mobileDir, 'index.html'), '<html></html>');
    writeFileSync(join(mobileDir, 'sw.js'), '// sw');
    writeFileSync(join(mobileDir, 'assets', 'app.js'), 'console.log(1);');

    const gwStatic = new RemoteGateway({
      dataDir: join(dataDir, 'd2'),
      mobileDir,
      log: silentLogger(),
      electronSend: () => {},
      port: 0,
      host: '127.0.0.1',
    });
    cleanups.push(async () => { await gwStatic.close(); });

    const s2 = await gwStatic.enable(true);
    const swRes = await rawHttpGet(`${s2.localUrl}/sw.js`);
    expect(swRes.status).toBe(200);
    expect(swRes.headers['cache-control']).toBe('no-cache');

    const jsRes = await rawHttpGet(`${s2.localUrl}/assets/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('ws-session: comando sem bridge retorna APP_UNAVAILABLE, erro inesperado retorna INTERNAL, auth repetido e JSON inválido dão USAGE sem fechar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-gw-char-ws-'));
    const gw = new RemoteGateway({ dataDir, log: silentLogger(), electronSend: () => {}, port: 0, host: '127.0.0.1' });
    cleanups.push(async () => { await gw.close(); try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });

    const status = await gw.enable(true);
    const { ws, waitMsg } = await openAuthedWs(gw, status.localUrl);

    ws.send('{invalid');
    expect(await waitMsg()).toEqual({ type: 'error', error: { code: 'USAGE', message: 'JSON inválido.' } });

    ws.send(JSON.stringify({ type: 'auth', token: 'outro' }));
    expect(await waitMsg()).toEqual({ type: 'error', error: { code: 'USAGE', message: 'Cliente já autenticado.' } });

    ws.send(JSON.stringify({ type: 'command', id: 'cmd-no-bridge', method: 'workspace.list', params: {} }));
    expect(await waitMsg()).toEqual({
      type: 'response-error',
      id: 'cmd-no-bridge',
      error: { code: 'APP_UNAVAILABLE', message: 'Núcleo indisponível.' },
    });

    gw.attachBridge({
      handle: async () => { throw new Error('falha inesperada'); },
      dispatchForTest: async () => ({}),
      close: async () => {},
    });
    ws.send(JSON.stringify({ type: 'command', id: 'cmd-err', method: 'workspace.list', params: {} }));
    expect(await waitMsg()).toEqual({
      type: 'response-error',
      id: 'cmd-err',
      error: { code: 'INTERNAL', message: 'Erro interno do Orquestra.' },
    });
    ws.close();
  });

  it('origin/listeners: normaliza [::1] para URL IPv6 e aceita Origin correspondente no WebSocket', async () => {
    expect(isAllowedBindHost(' [::1] ')).toBe(true);
    expect(isAllowedBindHost('100.64.0.1')).toBe(true);
    expect(isAllowedBindHost('100.128.0.1')).toBe(false);

    const dataDir = mkdtempSync(join(tmpdir(), 'orq-gw-char-v6-'));
    const gw = new RemoteGateway({ dataDir, log: silentLogger(), electronSend: () => {}, port: 0, host: '[::1]' });
    cleanups.push(async () => { await gw.close(); try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });

    const status = await gw.enable(true);
    expect(status.localUrl).toBe(`http://[::1]:${status.port}`);
    const { ws } = await openAuthedWs(gw, status.localUrl, status.localUrl);
    ws.close();
  });

  it('defaultMobileDir resolve os três layouts e funciona quando empacotado num único host.mjs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orq-mobile-dir-'));
    const proc = process as NodeJS.Process & { resourcesPath?: string };
    const hadEnv = 'ORQ_MOBILE_DIR' in process.env;
    const prevEnv = process.env.ORQ_MOBILE_DIR;
    const hadResources = 'resourcesPath' in proc;
    const prevResources = proc.resourcesPath;
    delete process.env.ORQ_MOBILE_DIR;
    delete proc.resourcesPath;

    try {
      // Layout 1: dev empacotado (packages/host/dist/host.mjs -> packages/mobile/dist)
      const devRoot = join(root, 'layout-dev');
      const devHost = join(devRoot, 'packages', 'host', 'dist', 'host.mjs');
      const devMobile = join(devRoot, 'packages', 'mobile', 'dist');
      mkdirSync(dirname(devHost), { recursive: true });
      mkdirSync(devMobile, { recursive: true });
      writeFileSync(devHost, '');
      writeFileSync(join(devMobile, 'index.html'), '<html>dev</html>');
      expect(defaultMobileDir(pathToFileURL(devHost).href)).toBe(resolve(devMobile));

      // Layout 2: app instalado (resources/host/host.mjs -> resources/mobile)
      const pkgRoot = join(root, 'layout-pkg');
      const pkgHost = join(pkgRoot, 'resources', 'host', 'host.mjs');
      const pkgMobile = join(pkgRoot, 'resources', 'mobile');
      mkdirSync(dirname(pkgHost), { recursive: true });
      mkdirSync(pkgMobile, { recursive: true });
      writeFileSync(pkgHost, '');
      writeFileSync(join(pkgMobile, 'index.html'), '<html>pkg</html>');
      expect(defaultMobileDir(pathToFileURL(pkgHost).href)).toBe(resolve(pkgMobile));

      // Layout 3: fonte TS (packages/host/src/remote/gateway.ts -> packages/mobile/dist)
      const srcRoot = join(root, 'layout-src');
      const srcGateway = join(srcRoot, 'packages', 'host', 'src', 'remote', 'gateway.ts');
      const srcMobile = join(srcRoot, 'packages', 'mobile', 'dist');
      mkdirSync(dirname(srcGateway), { recursive: true });
      mkdirSync(srcMobile, { recursive: true });
      writeFileSync(srcGateway, '');
      writeFileSync(join(srcMobile, 'index.html'), '<html>src</html>');
      expect(defaultMobileDir(pathToFileURL(srcGateway).href)).toBe(resolve(srcMobile));

      // Reprodução real de empacotamento esbuild (--bundle em arquivo único, onde os dois import.meta.url coincidem)
      const hereDir = dirname(fileURLToPath(import.meta.url));
      const httpEntry = resolve(hereDir, '../src/remote/gateway/http.ts');
      await esbuildBundle({
        stdin: {
          contents: `import { defaultMobileDir } from ${JSON.stringify(httpEntry)}; export function mobileFromHostBundle() { return defaultMobileDir(import.meta.url); }`,
          resolveDir: hereDir,
          loader: 'ts',
        },
        outfile: devHost,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
      });
      await esbuildBundle({
        stdin: {
          contents: `import { defaultMobileDir } from ${JSON.stringify(httpEntry)}; export function mobileFromHostBundle() { return defaultMobileDir(import.meta.url); }`,
          resolveDir: hereDir,
          loader: 'ts',
        },
        outfile: pkgHost,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
      });

      const devBundle = (await import(pathToFileURL(devHost).href)) as { mobileFromHostBundle: () => string };
      const pkgBundle = (await import(pathToFileURL(pkgHost).href)) as { mobileFromHostBundle: () => string };
      expect(devBundle.mobileFromHostBundle()).toBe(resolve(devMobile));
      expect(pkgBundle.mobileFromHostBundle()).toBe(resolve(pkgMobile));
    } finally {
      if (hadEnv) process.env.ORQ_MOBILE_DIR = prevEnv;
      else delete process.env.ORQ_MOBILE_DIR;
      if (hadResources) proc.resourcesPath = prevResources;
      else delete proc.resourcesPath;
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });
});
