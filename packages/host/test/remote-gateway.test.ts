import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { pino } from 'pino';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  hostMethodSchemas,
  isRemoteAllowedMethod,
  REMOTE_ALLOWED_METHODS,
  type HostToMain,
  type MainToHost,
  type ProjectSnapshot,
} from '@orquestra/shared';
import { silentLogger, type Logger } from '../../core/src/log.js';
import { FakePtyHost } from '../../core/test/helpers/fake-pty-host.js';
import { createFakeAdapter } from '../../core/test/helpers/fake-adapter.js';
import type { HostBridge } from '../src/bridge.js';
import { isAllowedBindHost, RemoteGateway } from '../src/remote/gateway.js';
import { startWorkspaceManager } from '../src/workspace-manager.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setupGateway(opts?: { authTimeoutMs?: number; rateLimit?: number; pairTtlMs?: number; mobileDir?: string; log?: Logger; port?: number; outputBufferLimit?: number; outputFlushMs?: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orq-gateway-test-'));
  const mobileDir = opts?.mobileDir ?? join(dataDir, 'mobile-dist');
  mkdirSync(mobileDir, { recursive: true });
  writeFileSync(join(mobileDir, 'index.html'), '<!doctype html><html><body>Orquestra Mobile</body></html>');

  let clock = 1_000_000;
  const electronSent: HostToMain[] = [];
  const gateway = new RemoteGateway({
    dataDir,
    log: opts?.log ?? silentLogger(),
    electronSend: (msg) => electronSent.push(msg),
    port: opts?.port ?? 0,
    outputBufferLimit: opts?.outputBufferLimit,
    outputFlushMs: opts?.outputFlushMs,
    mobileDir,
    authTimeoutMs: opts?.authTimeoutMs ?? 5_000,
    rateLimit: opts?.rateLimit ?? 5,
    pairTtlMs: opts?.pairTtlMs ?? 300_000,
    now: () => clock,
  });

  const ptyHost = new FakePtyHost();
  const inner = await startWorkspaceManager({
    send: (msg) => gateway.onHostMessage(msg),
    adapters: { shell: createFakeAdapter(), claude: createFakeAdapter() },
    cliScript: 'C:/orq/bin/orq.mjs',
    pipePath: `\\\\.\\pipe\\orq-gw-${randomUUID()}`,
    dataDir,
    log: silentLogger(),
    ptyHost,
    readyQuietMs: 10,
    outputIntervalMs: 5,
    recentFile: join(dataDir, 'recent.json'),
    settingsFile: join(dataDir, 'settings.json'),
    personasFile: join(dataDir, 'personas.json'),
    agentPidFile: join(dataDir, 'pids.json'),
    agyHooksFile: join(dataDir, 'agy-hooks.json'),
    modelCatalogDeps: {
      probeVersion: async () => null,
      probeClaudeCatalogMtime: () => null,
      discover: async (agent) => { throw new Error(`${agent} desativado`); },
    },
  });

  const bridge: HostBridge = gateway.wrapBridge(inner);
  await gateway.init();

  cleanups.push(async () => {
    await bridge.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  async function electronCommand(method: string, params: unknown = {}, workspaceId?: string) {
    const id = randomUUID();
    await bridge.handle({ kind: 'command', id, method, params, workspaceId });
    const resp = electronSent.find((m) => (m.kind === 'response' || m.kind === 'response-error') && m.id === id);
    if (resp?.kind === 'response-error') throw Object.assign(new Error(resp.error.message), { code: resp.error.code });
    if (resp?.kind !== 'response') throw new Error('Sem resposta para o Electron');
    return resp.result;
  }

  return {
    gateway,
    bridge,
    electronSent,
    electronCommand,
    ptyHost,
    dataDir,
    advanceClock: (ms: number) => { clock += ms; },
  };
}

async function pairDevice(baseUrl: string, pairToken: string, deviceName: string) {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairToken, deviceName }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function connectWs(baseUrl: string, headers?: Record<string, string>) {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, { headers });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  return { ws, messages };
}

async function waitForMsg(messages: any[], pred: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timeout aguardando mensagem. Recebidas: ${JSON.stringify(messages)}`);
}

describe('RemoteGateway', () => {
  it('inicia desligado por padrão, liga em runtime, serve estático e exige Bearer no HTTP', async () => {
    const { gateway, electronCommand } = await setupGateway();
    expect(await electronCommand('remote.status')).toMatchObject({ enabled: false });

    await expect(electronCommand('remote.pair')).rejects.toMatchObject({ code: 'USAGE' });

    const enabled = (await electronCommand('remote.enable', { enabled: true })) as { enabled: boolean; localUrl: string };
    expect(enabled.enabled).toBe(true);

    const htmlRes = await fetch(`${enabled.localUrl}/`);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain('Orquestra Mobile');

    const meUnauth = await fetch(`${enabled.localUrl}/api/me`);
    expect(meUnauth.status).toBe(401);

    const pair = (await electronCommand('remote.pair')) as { token: string; url: string };
    const paired = await pairDevice(enabled.localUrl, pair.token, 'Pixel');
    expect(paired.status).toBe(200);

    const meAuth = await fetch(`${enabled.localUrl}/api/me`, {
      headers: { Authorization: `Bearer ${paired.body.deviceToken}` },
    });
    expect(meAuth.status).toBe(200);
    expect((await meAuth.json()).device.name).toBe('Pixel');
  });

  it('recusa conexão sem auth no prazo, token inválido, Origin inválida e dispositivo revogado', async () => {
    const { electronCommand } = await setupGateway({ authTimeoutMs: 120 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const paired = await pairDevice(status.localUrl, pair.token, 'Celular');

    // Origin inválida é recusada no handshake HTTP 403
    const badOrigin = connectWs(status.localUrl, { Origin: 'https://malicioso.example' });
    const badOriginErr = await new Promise<Error | null>((resolve) => {
      badOrigin.ws.on('unexpected-response', () => resolve(new Error('403')));
      badOrigin.ws.on('error', (err) => resolve(err));
    });
    expect(badOriginErr).not.toBeNull();

    // Sem enviar auth fecha em ~120 ms
    const noAuth = connectWs(status.localUrl);
    const closedNoAuth = await new Promise<number>((resolve) => noAuth.ws.on('close', (code) => resolve(code)));
    expect(closedNoAuth).toBe(4001);

    // Token inválido é recusado
    const wrongTok = connectWs(status.localUrl);
    await new Promise<void>((resolve) => wrongTok.ws.on('open', () => resolve()));
    wrongTok.ws.send(JSON.stringify({ type: 'auth', token: 'token-invalido' }));
    const authErr = await waitForMsg(wrongTok.messages, (m) => m.type === 'auth-error');
    expect(authErr.error.code).toBe('INVALID_TOKEN');

    // Token válido funciona, mas após revogar desconecta imediatamente e recusa reconexão
    const valid = connectWs(status.localUrl);
    await new Promise<void>((resolve) => valid.ws.on('open', () => resolve()));
    valid.ws.send(JSON.stringify({ type: 'auth', token: paired.body.deviceToken }));
    await waitForMsg(valid.messages, (m) => m.type === 'auth-ok');

    const closedPromise = new Promise<number>((resolve) => valid.ws.on('close', (code) => resolve(code)));
    await electronCommand('remote.revoke', { id: paired.body.device.id });
    expect(await closedPromise).toBe(4003);

    const afterRevoke = connectWs(status.localUrl);
    await new Promise<void>((resolve) => afterRevoke.ws.on('open', () => resolve()));
    afterRevoke.ws.send(JSON.stringify({ type: 'auth', token: paired.body.deviceToken }));
    const revokedErr = await waitForMsg(afterRevoke.messages, (m) => m.type === 'auth-error');
    expect(revokedErr.error.code).toBe('INVALID_TOKEN');
  });

  it('recusa métodos fora da lista e mensagens > 64 KB', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const paired = await pairDevice(status.localUrl, pair.token, 'Celular');

    const { ws, messages } = connectWs(status.localUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'auth', token: paired.body.deviceToken }));
    await waitForMsg(messages, (m) => m.type === 'auth-ok');

    for (const forbidden of ['files.read', 'settings.update', 'terminal.create', 'terminal.remove', 'remote.enable']) {
      const id = `cmd-${forbidden}`;
      ws.send(JSON.stringify({ type: 'command', id, method: forbidden, params: {} }));
      const resp = await waitForMsg(messages, (m) => m.id === id);
      expect(resp.type).toBe('response-error');
      expect(resp.error.code).toBe('UNSUPPORTED');
    }

    // Mensagem > 64 KB é encerrada pelo gateway
    const closedLarge = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'command', id: 'big', method: 'terminal.input', params: { name: 'A', data: 'x'.repeat(70 * 1024) } }));
    expect(await closedLarge).toBe(1009);
  });

  it('isola respostas por conexão (sem vazar para Electron ou outro cliente) e roteia eventos sem vazar confirm ou terminal.output', async () => {
    const { gateway, electronSent, electronCommand, ptyHost, dataDir } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };

    const p1 = (await electronCommand('remote.pair')) as { token: string };
    const p2 = (await electronCommand('remote.pair')) as { token: string };
    const dev1 = await pairDevice(status.localUrl, p1.token, 'Celular 1');
    const dev2 = await pairDevice(status.localUrl, p2.token, 'Celular 2');

    const projDir = join(dataDir, 'proj');
    mkdirSync(projDir, { recursive: true });
    const snap = (await electronCommand('project.open', { dir: projDir })) as ProjectSnapshot;
    await electronCommand('terminal.create', { name: 'A', agent: 'shell' }, snap.workspaceId);

    const c1 = connectWs(status.localUrl);
    const c2 = connectWs(status.localUrl);
    await Promise.all([
      new Promise<void>((r) => c1.ws.on('open', () => r())),
      new Promise<void>((r) => c2.ws.on('open', () => r())),
    ]);
    c1.ws.send(JSON.stringify({ type: 'auth', token: dev1.body.deviceToken }));
    c2.ws.send(JSON.stringify({ type: 'auth', token: dev2.body.deviceToken }));
    await Promise.all([
      waitForMsg(c1.messages, (m) => m.type === 'auth-ok'),
      waitForMsg(c2.messages, (m) => m.type === 'auth-ok'),
    ]);

    const sentBefore = electronSent.length;
    c1.ws.send(JSON.stringify({ type: 'command', id: 'c1-list', method: 'workspace.list', params: {} }));
    const r1 = await waitForMsg(c1.messages, (m) => m.id === 'c1-list');
    expect(r1.type).toBe('response');
    expect(r1.result.workspaces).toHaveLength(1);
    expect(r1.result.workspaces[0]).not.toHaveProperty('dir');
    expect(r1.result.workspaces[0].name).toBe('proj');

    // Resposta do c1 NÃO chega no c2 nem no Electron
    expect(c2.messages.some((m) => m.id === 'c1-list')).toBe(false);
    expect(electronSent.slice(sentBefore).some((m) => m.kind === 'response' && m.id === 'c1-list')).toBe(false);

    // Confirm fica só no Electron
    gateway.onHostMessage({ kind: 'confirm', id: 'conf-1', message: 'Aprovar?' });
    expect(electronSent.some((m) => m.kind === 'confirm' && m.id === 'conf-1')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(c1.messages.some((m) => m.id === 'conf-1' || m.type === 'confirm')).toBe(false);
    expect(c2.messages.some((m) => m.id === 'conf-1' || m.type === 'confirm')).toBe(false);

    // Evento terminal.output vai ao Electron, mas NÃO vaza para c1/c2 sem assinatura
    ptyHost.spawned[0]!.pty.emitData('segredo-do-terminal');
    await new Promise((r) => setTimeout(r, 40));
    expect(electronSent.some((m) => m.kind === 'event' && m.event.type === 'terminal.output')).toBe(true);
    expect(c1.messages.some((m) => m.type === 'event' && m.event.type === 'terminal.output')).toBe(false);
    expect(c2.messages.some((m) => m.type === 'event' && m.event.type === 'terminal.output')).toBe(false);

    // Eventos de estado chegam ao Electron e aos dois clientes autenticados
    gateway.onHostMessage({
      kind: 'event',
      event: { type: 'terminal.state', name: 'A', state: 'waiting', queued: 0, workspaceId: snap.workspaceId, sequence: 99 },
    });
    await waitForMsg(c1.messages, (m) => m.type === 'event' && m.event.type === 'terminal.state' && m.event.state === 'waiting');
    await waitForMsg(c2.messages, (m) => m.type === 'event' && m.event.type === 'terminal.state' && m.event.state === 'waiting');
    expect(electronSent.some((m) => m.kind === 'event' && m.event.type === 'terminal.state' && m.event.state === 'waiting')).toBe(true);
  });

  it('aplica rate limit de pareamento no endpoint HTTP /api/pair (429)', async () => {
    const { electronCommand } = await setupGateway({ rateLimit: 5 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    for (let i = 0; i < 5; i++) {
      const r = await pairDevice(status.localUrl, 'invalido', 'Dev');
      expect(r.status).toBe(401);
    }
    const blocked = await pairDevice(status.localUrl, 'invalido', 'Dev');
    expect(blocked.status).toBe(429);
  });
});

function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: Number(url.port), path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function recordingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino({ level: 'info' }, { write: (line: string) => { lines.push(JSON.parse(line)); } });
  return { log, lines };
}

async function authedClient(baseUrl: string, pairToken: string, name: string) {
  const dev = await pairDevice(baseUrl, pairToken, name);
  const client = connectWs(baseUrl);
  await new Promise<void>((r) => client.ws.on('open', () => r()));
  client.ws.send(JSON.stringify({ type: 'auth', token: dev.body.deviceToken }));
  await waitForMsg(client.messages, (m) => m.type === 'auth-ok');
  return { ...client, device: dev.body.device as { id: string }, token: dev.body.deviceToken as string };
}

describe('RemoteGateway: arquivos estáticos', () => {
  it('recusa path traversal, pasta irmã com o mesmo prefixo, caminho absoluto, junction e URL malformada sem derrubar o servidor', async () => {
    const { dataDir, electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const mobileDir = join(dataDir, 'mobile-dist');
    const siblingDir = join(dataDir, 'mobile-dist-backup');
    mkdirSync(siblingDir, { recursive: true });
    const secret = join(siblingDir, 'secret.json');
    writeFileSync(secret, '{"segredo":"SEGREDO-FORA-DA-RAIZ"}');

    const attempts = [
      '/../mobile-dist-backup/secret.json',
      '/%2e%2e/mobile-dist-backup/secret.json',
      '/%2E%2E%2Fmobile-dist-backup%2Fsecret.json',
      '/..%5cmobile-dist-backup%5csecret.json',
      `/${secret.replace(/\\/g, '/')}`,
      '/%00',
    ];
    for (const path of attempts) {
      const res = await rawGet(status.localUrl, path);
      expect(res.body, path).not.toContain('SEGREDO-FORA-DA-RAIZ');
      // new URL() já resolve "/.." para dentro da raiz: nesse caso cai no index (nunca no arquivo de fora).
      if (res.status === 200) expect(res.body, path).toContain('Orquestra Mobile');
      else expect([400, 403], path).toContain(res.status);
    }

    // Junction (não exige privilégio de administrador no Windows) apontando para fora da raiz.
    symlinkSync(siblingDir, join(mobileDir, 'atalho'), 'junction');
    const viaLink = await rawGet(status.localUrl, '/atalho/secret.json');
    expect(viaLink.status).toBe(403);
    expect(viaLink.body).not.toContain('SEGREDO-FORA-DA-RAIZ');

    // URL relativa ao esquema ("//[::1") faz new URL() lançar: precisa virar 400, nunca derrubar o processo.
    const malformed = await rawGet(status.localUrl, '//[::1');
    expect(malformed.status).toBe(400);
    const still = await fetch(`${status.localUrl}/api/health`);
    expect(still.status).toBe(200);
  });

  it('mobileDir vazio não expõe o diretório atual do processo', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-gateway-empty-'));
    cleanups.push(async () => { rmSync(dataDir, { recursive: true, force: true }); });
    const gateway = new RemoteGateway({ dataDir, log: silentLogger(), electronSend: () => {}, port: 0, mobileDir: '' });
    cleanups.push(() => gateway.close());
    const status = await gateway.enable(true);
    const res = await rawGet(status.localUrl, '/package.json');
    expect(res.body).not.toContain('"workspaces"');
  });

  it('envia cabeçalhos de segurança em toda resposta', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    for (const path of ['/', '/api/health', '/api/me', '/nao-existe-api']) {
      const res = await fetch(`${status.localUrl}${path}`);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
    }
  });
});

describe('RemoteGateway: escuta e pareamento HTTP', () => {
  it('escuta somente em 127.0.0.1 e recusa 0.0.0.0, ::, LAN e hostnames', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string; port: number };
    expect(status.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const lanIps = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
    for (const ip of lanIps.slice(0, 1)) {
      await expect(fetch(`http://${ip}:${status.port}/api/health`)).rejects.toThrow();
    }

    for (const host of ['0.0.0.0', '::', '192.168.0.10', '10.0.0.1', 'localhost', '100.63.255.255', '100.128.0.1', '']) {
      const ctor = () => new RemoteGateway({ dataDir: tmpdir(), log: silentLogger(), electronSend: () => {}, host: host || ' ' });
      expect(ctor, host).toThrow();
    }
    for (const host of ['127.0.0.1', '::1', '100.64.0.1', '100.127.255.254']) expect(isAllowedBindHost(host), host).toBe(true);
  });

  it('rejeita POST /api/pair com Origin alheia, Content-Type diferente de JSON, JSON inválido e corpo acima de 64 KB', async () => {
    const { electronCommand } = await setupGateway({ rateLimit: 100 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const post = (init: RequestInit) => fetch(`${status.localUrl}/api/pair`, { method: 'POST', ...init });
    const body = JSON.stringify({ pairToken: 'x', deviceName: 'Cel' });

    expect((await post({ headers: { 'Content-Type': 'application/json', Origin: 'https://malicioso.example' }, body })).status).toBe(403);
    expect((await post({ headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(415);
    expect((await post({ headers: { 'Content-Type': 'application/json' }, body: '{nao-e-json' })).status).toBe(400);
    expect((await post({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairToken: 'x', deviceName: 'y'.repeat(70 * 1024) }) })).status).toBe(413);
    const missing = await post({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairToken: '', deviceName: 'Cel' }) });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toBe('Informe o código de pareamento.');
  });

  it('só aceita o token de dispositivo em Authorization: Bearer', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const paired = await pairDevice(status.localUrl, pair.token, 'Cel');
    const token = paired.body.deviceToken as string;

    expect((await fetch(`${status.localUrl}/api/me?token=${token}`)).status).toBe(401);
    expect((await fetch(`${status.localUrl}/api/me`, { headers: { Authorization: `Basic ${token}` } })).status).toBe(401);
    expect((await fetch(`${status.localUrl}/api/me`, { headers: { 'X-Token': token } })).status).toBe(401);
    expect((await fetch(`${status.localUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('RemoteGateway: WebSocket', () => {
  it('comando antes do auth fecha a conexão com 4001 e não executa nada', async () => {
    const { electronCommand, electronSent } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const { ws, messages } = connectWs(status.localUrl);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const before = electronSent.length;
    ws.send(JSON.stringify({ type: 'command', id: 'pre', method: 'workspace.list', params: {} }));
    expect(await closed).toBe(4001);
    expect(messages.some((m) => m.id === 'pre')).toBe(false);
    expect(electronSent.slice(before).some((m) => 'id' in m && String(m.id).startsWith('remote:'))).toBe(false);
  });

  it('JSON inválido na primeira mensagem encerra a conexão não autenticada com 4001', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const { ws } = connectWs(status.localUrl);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.send('{isto não é json');
    expect(await closed).toBe(4001);
  });

  it('o prazo de autenticação esgotado usa type "error" (o cliente reconecta), não auth-error', async () => {
    const { electronCommand } = await setupGateway({ authTimeoutMs: 80 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const { ws, messages } = connectWs(status.localUrl);
    await new Promise<void>((r) => ws.on('close', () => r()));
    expect(messages.some((m) => m.type === 'error')).toBe(true);
    expect(messages.some((m) => m.type === 'auth-error')).toBe(false);
  });

  it('recusa todo método fora de REMOTE_ALLOWED_METHODS e a allowlist só contém métodos existentes', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');

    const all = Object.keys(hostMethodSchemas);
    for (const allowed of REMOTE_ALLOWED_METHODS) expect(all, allowed).toContain(allowed);
    const forbidden = all.filter((m) => !(REMOTE_ALLOWED_METHODS as readonly string[]).includes(m));
    expect(forbidden.length).toBeGreaterThan(20);
    for (const m of all) expect(isRemoteAllowedMethod(m), m).toBe(!forbidden.includes(m));
    for (const required of ['persona.', 'project.open', 'project.close', 'portal.', 'terminal.remove', 'terminal.update', 'terminal.duplicate', 'note.']) {
      expect(forbidden.some((m) => m.startsWith(required)), required).toBe(true);
    }

    for (const method of forbidden) {
      const id = `x-${method}`;
      client.ws.send(JSON.stringify({ type: 'command', id, method, params: {} }));
    }
    for (const method of forbidden) {
      const resp = await waitForMsg(client.messages, (m) => m.id === `x-${method}`, 5000);
      expect(resp.type, method).toBe('response-error');
      expect(resp.error.code, method).toBe('UNSUPPORTED');
    }
  });

  it('valida params, audita {deviceId, method, terminal} e nunca registra o texto digitado', async () => {
    const { log, lines } = recordingLogger();
    const { electronCommand, dataDir } = await setupGateway({ log });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const projDir = join(dataDir, 'proj');
    mkdirSync(projDir, { recursive: true });
    const snap = (await electronCommand('project.open', { dir: projDir })) as ProjectSnapshot;
    await electronCommand('terminal.create', { name: 'A', agent: 'shell' }, snap.workspaceId);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Pixel');

    client.ws.send(JSON.stringify({ type: 'command', id: 'bad', method: 'terminal.input', params: { nome: 'A' } }));
    const bad = await waitForMsg(client.messages, (m) => m.id === 'bad');
    expect(bad.type).toBe('response-error');
    expect(bad.error.code).toBe('USAGE');

    client.ws.send(JSON.stringify({ type: 'command', id: 'ok', method: 'terminal.input', params: { name: 'A', data: 'senha-super-secreta\r' }, workspaceId: snap.workspaceId }));
    await waitForMsg(client.messages, (m) => m.id === 'ok');

    const audit = lines.find((l) => l.msg === 'comando remoto autorizado' && l.method === 'terminal.input');
    expect(audit).toMatchObject({ deviceId: client.device.id, deviceName: 'Pixel', method: 'terminal.input', terminal: 'A' });
    expect(JSON.stringify(lines)).not.toContain('senha-super-secreta');
  });

  it('não repassa portal-call, portal-cancel, confirm nem eventos de notas, grupos e arestas ao celular', async () => {
    const { gateway, electronSent, electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const wsId = 'w1';

    const events = [
      { type: 'note.changed', note: { name: 'n', text: 'conteúdo sigiloso' }, connectedTo: null, rect: null, workspaceId: wsId },
      { type: 'note.removed', name: 'n', workspaceId: wsId },
      { type: 'group.layout', groups: [], layout: {}, workspaceId: wsId },
      { type: 'edge.added', a: 'A', b: 'B', workspaceId: wsId },
      { type: 'ask.answered', askId: 'k', from: 'A', target: 'B', workspaceId: wsId },
    ];
    for (const event of events) gateway.onHostMessage({ kind: 'event', event } as unknown as HostToMain);
    gateway.onHostMessage({ kind: 'portal-call', id: 'pc', browser: 'b', method: 'm', params: {} } as unknown as HostToMain);
    gateway.onHostMessage({ kind: 'portal-cancel', id: 'pc' } as unknown as HostToMain);
    gateway.onHostMessage({ kind: 'confirm', id: 'cf', message: 'ok?' });
    gateway.onHostMessage({ kind: 'event', event: { type: 'terminal.state', name: 'A', state: 'busy', queued: 0, workspaceId: wsId } });
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.state');

    const received = client.messages.filter((m) => m.type === 'event').map((m) => m.event.type);
    expect(received).toEqual(['terminal.state']);
    expect(JSON.stringify(client.messages)).not.toContain('conteúdo sigiloso');
    expect(electronSent.filter((m) => m.kind === 'event').map((m) => (m as any).event.type)).toEqual(expect.arrayContaining(['note.changed', 'group.layout', 'edge.added']));
    expect(electronSent.some((m) => m.kind === 'portal-call')).toBe(true);
    expect(client.messages.some((m) => m.type !== 'event' && m.type !== 'auth-ok')).toBe(false);
  });

  it('resposta atrasada de conexão encerrada não vaza para o Electron', async () => {
    const { gateway, electronSent, electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');

    client.ws.send(JSON.stringify({ type: 'command', id: 'late', method: 'workspace.list', params: {} }));
    client.ws.terminate();
    await new Promise((r) => setTimeout(r, 150));
    gateway.onHostMessage({ kind: 'response', id: 'remote:conexao-morta:abc', ok: true, result: {} });
    gateway.onHostMessage({ kind: 'response-error', id: 'remote:conexao-morta:def', error: { code: 'INTERNAL', message: 'x' } });
    expect(electronSent.some((m) => 'id' in m && String(m.id).startsWith('remote:'))).toBe(false);
  });

  it('revogar o dispositivo bloqueia comandos enviados durante o fechamento da conexão', async () => {
    const { electronCommand, electronSent } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    await electronCommand('remote.revoke', { id: client.device.id });
    const before = electronSent.length;
    client.ws.send(JSON.stringify({ type: 'command', id: 'depois', method: 'workspace.list', params: {} }));
    await new Promise((r) => setTimeout(r, 150));
    expect(client.messages.some((m) => m.id === 'depois')).toBe(false);
    expect(electronSent.slice(before).some((m) => 'id' in m && String(m.id).startsWith('remote:'))).toBe(false);
  });

  it('workspace.activate pelo celular emite workspace.activated ao desktop e aos demais celulares', async () => {
    const { electronSent, electronCommand, dataDir } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const dirA = join(dataDir, 'a');
    const dirB = join(dataDir, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const a = (await electronCommand('project.open', { dir: dirA })) as ProjectSnapshot;
    await electronCommand('project.open', { dir: dirB });

    const p1 = (await electronCommand('remote.pair')) as { token: string };
    const p2 = (await electronCommand('remote.pair')) as { token: string };
    const c1 = await authedClient(status.localUrl, p1.token, 'Cel 1');
    const c2 = await authedClient(status.localUrl, p2.token, 'Cel 2');

    c1.ws.send(JSON.stringify({ type: 'command', id: 'act', method: 'workspace.activate', params: { id: a.workspaceId } }));
    const resp = await waitForMsg(c1.messages, (m) => m.id === 'act');
    expect(resp.type).toBe('response');
    expect(resp.result.workspaceId).toBe(a.workspaceId);

    const activated = await waitForMsg(c2.messages, (m) => m.type === 'event' && m.event.type === 'workspace.activated');
    expect(activated.event.workspaceId).toBe(a.workspaceId);
    expect(electronSent.some((m) => m.kind === 'event' && m.event.type === 'workspace.activated' && m.event.workspaceId === a.workspaceId)).toBe(true);
  });
});

describe('RemoteGateway: ciclo de vida', () => {
  it('desligar em runtime fecha clientes, libera a porta e fecha rápido mesmo com conexão aberta', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string; port: number };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const closed = new Promise<void>((r) => client.ws.on('close', () => r()));

    const started = Date.now();
    const off = (await electronCommand('remote.enable', { enabled: false })) as { enabled: boolean };
    expect(off.enabled).toBe(false);
    await closed;
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(fetch(`${status.localUrl}/api/health`)).rejects.toThrow();

    // A porta ficou livre de fato.
    const probe = createNetServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(status.port, '127.0.0.1', () => resolve()); });
    expect((probe.address() as AddressInfo).port).toBe(status.port);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it('porta em uso vira CONFLICT em pt-BR e não deixa o estado "ligado" gravado', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const busyPort = (blocker.address() as AddressInfo).port;

    const { gateway, electronCommand } = await setupGateway({ port: busyPort });
    await expect(electronCommand('remote.enable', { enabled: true })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('já está em uso') });
    expect(gateway.status().enabled).toBe(false);
    expect(gateway.store.isEnabled()).toBe(false);
  });
});

async function openProjectWithTerminals(electronCommand: (m: string, p?: unknown, w?: string) => Promise<unknown>, dir: string, names: string[]) {
  mkdirSync(dir, { recursive: true });
  const snap = (await electronCommand('project.open', { dir })) as ProjectSnapshot;
  for (const name of names) await electronCommand('terminal.create', { name, agent: 'shell' }, snap.workspaceId);
  return snap;
}
const outputs = (messages: any[], name?: string) =>
  messages.filter((m) => m.type === 'event' && m.event.type === 'terminal.output' && (!name || m.event.name === name));

describe('RemoteGateway: snapshot remoto filtrado', () => {
  it('workspace.activate devolve só terminais, filas, nome e sequência: sem notas, grupos, layout nem diretório', async () => {
    const { electronCommand, dataDir } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A']);
    await electronCommand('note.create', { name: 'segredos', content: 'CONTEUDO-SIGILOSO-DA-NOTA' }, snap.workspaceId);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');

    client.ws.send(JSON.stringify({ type: 'command', id: 'act', method: 'workspace.activate', params: { id: snap.workspaceId } }));
    const resp = await waitForMsg(client.messages, (m) => m.id === 'act');
    expect(resp.type).toBe('response');
    expect(Object.keys(resp.result).sort()).toEqual(expect.arrayContaining(['eventSequence', 'name', 'terminals', 'workspaceId']));
    for (const forbidden of ['notes', 'groups', 'layout', 'edges', 'viewport', 'dir']) expect(resp.result, forbidden).not.toHaveProperty(forbidden);
    expect(resp.result.terminals.map((t: any) => t.name)).toEqual(['A']);
    expect(JSON.stringify(client.messages)).not.toContain('CONTEUDO-SIGILOSO-DA-NOTA');
  });
});

describe('RemoteGateway: assinatura da saída do terminal', () => {
  it('só entrega saída de terminais assinados, agrupada em lotes, e para ao cancelar a assinatura', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A', 'B']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const [ptyA, ptyB] = [ptyHost.spawned[0]!.pty, ptyHost.spawned[1]!.pty];

    ptyA.emitData('antes-da-assinatura');
    await new Promise((r) => setTimeout(r, 120));
    expect(outputs(client.messages)).toHaveLength(0);

    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 30));
    for (const piece of ['um-', 'dois-', 'tres']) {
      ptyA.emitData(piece);
      await new Promise((r) => setTimeout(r, 8));
    }
    ptyB.emitData('terminal-nao-assinado');
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.output');
    await new Promise((r) => setTimeout(r, 120));
    const received = outputs(client.messages);
    expect(received).toHaveLength(1);
    expect(received[0].event).toMatchObject({ name: 'A', data: 'um-dois-tres', workspaceId: snap.workspaceId });
    expect(outputs(client.messages, 'B')).toHaveLength(0);

    client.ws.send(JSON.stringify({ type: 'unsubscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 30));
    ptyA.emitData('depois-de-cancelar');
    await new Promise((r) => setTimeout(r, 120));
    expect(outputs(client.messages)).toHaveLength(1);
  });

  it('trocar de workspace encerra as assinaturas; saída de workspace inativo nunca chega', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const a = await openProjectWithTerminals(electronCommand, join(dataDir, 'a'), ['A']);
    const b = await openProjectWithTerminals(electronCommand, join(dataDir, 'b'), ['B']); // b fica ativo
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const [ptyA, ptyB] = [ptyHost.spawned[0]!.pty, ptyHost.spawned[1]!.pty];

    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: a.workspaceId, name: 'A' }));
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: b.workspaceId, name: 'B' }));
    await new Promise((r) => setTimeout(r, 30));
    ptyA.emitData('saida-de-A-inativo');
    ptyB.emitData('saida-de-B');
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.output' && m.event.name === 'B');
    expect(outputs(client.messages, 'A')).toHaveLength(0);

    client.ws.send(JSON.stringify({ type: 'command', id: 'troca', method: 'workspace.activate', params: { id: a.workspaceId } }));
    await waitForMsg(client.messages, (m) => m.id === 'troca');
    ptyB.emitData('B-em-segundo-plano');
    ptyA.emitData('A-agora-ativo');
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.output' && m.event.name === 'A');
    await new Promise((r) => setTimeout(r, 100));
    expect(outputs(client.messages, 'B').map((m) => m.event.data)).toEqual(['saida-de-B']);
  });

  it('acima do limite descarta o buffer, avisa com output-overflow e só volta a transmitir depois de um snapshot novo', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway({ outputBufferLimit: 200 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const pty = ptyHost.spawned[0]!.pty;

    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 30));
    pty.emitData('x'.repeat(500));
    const overflow = await waitForMsg(client.messages, (m) => m.type === 'output-overflow');
    expect(overflow).toMatchObject({ name: 'A', workspaceId: snap.workspaceId });
    await new Promise((r) => setTimeout(r, 120));
    expect(outputs(client.messages)).toHaveLength(0);

    pty.emitData('ainda-mudo');
    await new Promise((r) => setTimeout(r, 120));
    expect(outputs(client.messages)).toHaveLength(0);
    expect(client.messages.filter((m) => m.type === 'output-overflow')).toHaveLength(1);

    client.ws.send(JSON.stringify({ type: 'command', id: 'snap', method: 'terminal.snapshot', params: { name: 'A' }, workspaceId: snap.workspaceId }));
    const snapshot = await waitForMsg(client.messages, (m) => m.id === 'snap');
    expect(snapshot.result.data).toContain('ainda-mudo');
    pty.emitData('voltou');
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.output' && m.event.data === 'voltou');
  });

  it('a saída já contida no snapshot não é reenviada depois dele', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 30));
    ptyHost.spawned[0]!.pty.emitData('linha-no-retrato');
    client.ws.send(JSON.stringify({ type: 'command', id: 'snap', method: 'terminal.snapshot', params: { name: 'A' }, workspaceId: snap.workspaceId }));
    const snapshot = await waitForMsg(client.messages, (m) => m.id === 'snap');
    expect(snapshot.result.data).toContain('linha-no-retrato');
    await new Promise((r) => setTimeout(r, 150));
    expect(outputs(client.messages).some((m) => m.event.data.includes('linha-no-retrato'))).toBe(false);
  });

  it('assinar sem autenticar fecha a conexão com 4001', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const { ws } = connectWs(status.localUrl);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'w', name: 'A' }));
    expect(await closed).toBe(4001);
  });

  it('recalcula outputBytes ao remover saída pendente (unsubscribe, terminal.snapshot e workspace.activated) sem falso overflow', async () => {
    const { gateway, electronCommand, dataDir, ptyHost } = await setupGateway({ outputBufferLimit: 200, outputFlushMs: 250 });
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A', 'B']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');

    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'A' }));
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'B' }));
    await new Promise((r) => setTimeout(r, 30));

    // 1) unsubscribe remove 150 bytes pendentes de A; 100 bytes em B não podem somar 250 > 200.
    gateway.onHostMessage({ kind: 'event', event: { type: 'terminal.output', name: 'A', data: 'a'.repeat(150), workspaceId: snap.workspaceId } });
    client.ws.send(JSON.stringify({ type: 'unsubscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 20));
    gateway.onHostMessage({ kind: 'event', event: { type: 'terminal.output', name: 'B', data: 'b'.repeat(100), workspaceId: snap.workspaceId } });

    // 2) terminal.snapshot remove os 100 bytes de B; re-assinar A e emitir 150 bytes não pode causar overflow.
    client.ws.send(JSON.stringify({ type: 'command', id: 'snap-b', method: 'terminal.snapshot', params: { name: 'B' }, workspaceId: snap.workspaceId }));
    await waitForMsg(client.messages, (m) => m.id === 'snap-b');
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap.workspaceId, name: 'A' }));
    await new Promise((r) => setTimeout(r, 20));
    gateway.onHostMessage({ kind: 'event', event: { type: 'terminal.output', name: 'A', data: 'c'.repeat(150), workspaceId: snap.workspaceId } });

    // 3) workspace.activated remove os 150 bytes de A; assinar no novo workspace e emitir 120 bytes não causa overflow.
    const snap2 = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj2'), ['C']);
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'workspace.activated' && m.event.workspaceId === snap2.workspaceId);
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: snap2.workspaceId, name: 'C' }));
    await new Promise((r) => setTimeout(r, 20));
    gateway.onHostMessage({ kind: 'event', event: { type: 'terminal.output', name: 'C', data: 'd'.repeat(120), workspaceId: snap2.workspaceId } });

    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.output' && m.event.name === 'C');
    expect(client.messages.filter((m) => m.type === 'output-overflow')).toHaveLength(0);
    expect(ptyHost.spawned.length).toBeGreaterThanOrEqual(3);
  });

  it('aceita até 16 assinaturas e recusa a 17ª com USAGE', async () => {
    const { electronCommand } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');

    for (let i = 1; i <= 16; i++) {
      client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'w1', name: `T${i}` }));
    }
    // Reassinar uma existente dentre as 16 não conta como nova.
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'w1', name: 'T1' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(client.messages.filter((m) => m.type === 'error')).toHaveLength(0);

    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'w1', name: 'T17' }));
    const err = await waitForMsg(client.messages, (m) => m.type === 'error');
    expect(err.error).toMatchObject({ code: 'USAGE', message: expect.stringContaining('Assinaturas demais') });
  });
});

describe('RemoteGateway: terminal.send, terminal.key e recarga', () => {
  it('terminal.send digita a mensagem e envia Enter; terminal.key envia a tecla; exatamente 16 KB é aceito e mais de 16 KB é recusado', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    const pty = ptyHost.spawned[0]!.pty;
    const send = async (id: string, method: string, params: unknown) => {
      client.ws.send(JSON.stringify({ type: 'command', id, method, params, workspaceId: snap.workspaceId }));
      return waitForMsg(client.messages, (m) => m.id === id);
    };

    expect((await send('s1', 'terminal.send', { name: 'A', text: 'echo oi' })).type).toBe('response');
    expect(pty.written.slice(-2)).toEqual(['echo oi', '\r']);
    expect((await send('k1', 'terminal.key', { name: 'A', key: 'ArrowUp' })).type).toBe('response');
    expect(pty.written.at(-1)).toBe('\x1b[A');
    const exactMax = await send('s-max', 'terminal.send', { name: 'A', text: 'z'.repeat(16 * 1024) });
    expect(exactMax.type).toBe('response');
    expect(exactMax.ok).toBe(true);
    const tooBig = await send('s2', 'terminal.send', { name: 'A', text: 'y'.repeat(16 * 1024 + 1) });
    expect(tooBig.error.code).toBe('USAGE');
    expect((await send('k2', 'terminal.key', { name: 'A', key: 'F13' })).error.code).toBe('USAGE');
  });

  it('descarregar e recarregar pelo celular: o cartão volta a Ocioso e o terminal reabre', async () => {
    const { electronCommand, dataDir, ptyHost } = await setupGateway();
    const status = (await electronCommand('remote.enable', { enabled: true })) as { localUrl: string };
    const snap = await openProjectWithTerminals(electronCommand, join(dataDir, 'proj'), ['A']);
    const pair = (await electronCommand('remote.pair')) as { token: string };
    const client = await authedClient(status.localUrl, pair.token, 'Cel');
    ptyHost.spawned[0]!.pty.emitData('pronto> ');
    await new Promise((r) => setTimeout(r, 60));
    const send = async (id: string, method: string, params: unknown) => {
      client.ws.send(JSON.stringify({ type: 'command', id, method, params, workspaceId: snap.workspaceId }));
      return waitForMsg(client.messages, (m) => m.id === id);
    };

    const unloaded = await send('u', 'terminal.unload', { name: 'A' });
    expect(unloaded.result).toMatchObject({ name: 'A', unloaded: true, state: 'exited' });
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.replaced' && m.event.info.unloaded === true);

    const reloaded = await send('r', 'terminal.restart', { name: 'A' });
    expect(reloaded.result.unloaded).toBeFalsy();
    expect(ptyHost.spawned).toHaveLength(2);
    ptyHost.spawned[1]!.pty.emitData('pronto> ');
    await waitForMsg(client.messages, (m) => m.type === 'event' && m.event.type === 'terminal.state' && m.event.name === 'A' && m.event.state === 'idle');
    const replaced = client.messages.filter((m) => m.type === 'event' && m.event.type === 'terminal.replaced');
    expect(replaced.at(-1).event.info).toMatchObject({ name: 'A' });
    expect(replaced.at(-1).event.info.unloaded).toBeFalsy();
  });
});
