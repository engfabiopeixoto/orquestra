import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MobileNotifier, parseDeepLinkTarget } from '../src/notifications';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

describe('MobileNotifier: regra de quando notificar', () => {
  it('só notifica com permissão granted e página não visível ao entrar em waiting ou encerrar turno, com vibração, tag por terminal e sem conteúdo', () => {
    let permission: 'default' | 'granted' | 'denied' = 'granted';
    let visible = false;
    const shown: Array<{ title: string; options: any }> = [];
    const notifier = new MobileNotifier({
      getPermission: () => permission,
      isPageVisible: () => visible,
      showNotification: (title, options) => {
        shown.push({ title, options });
      },
    });

    // Terminal que já nasceu em waiting no snapshot não dispara até sair e entrar de novo.
    notifier.seedSnapshot({
      workspaceId: 'w1',
      terminals: [
        { name: 'revisor', state: 'waiting' },
        { name: 'dev-claude', state: 'busy' },
      ],
    });

    notifier.observeEvent({ type: 'terminal.state', name: 'revisor', state: 'waiting', queued: 1, workspaceId: 'w1' });
    expect(shown).toHaveLength(0);

    // Transição busy -> waiting com página oculta e permissão granted => notifica!
    notifier.observeEvent({ type: 'terminal.state', name: 'dev-claude', state: 'waiting', queued: 0, workspaceId: 'w1' });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toEqual({
      title: 'dev-claude está esperando você',
      options: {
        tag: 'orquestra:w1:dev-claude',
        vibrate: [200, 100, 200],
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { workspaceId: 'w1', terminal: 'dev-claude' },
      },
    });
    expect(shown[0]!.options.body).toBeUndefined();

    // Repetir waiting sem ter saído de waiting não re-notifica.
    notifier.observeEvent({ type: 'terminal.state', name: 'dev-claude', state: 'waiting', queued: 2, workspaceId: 'w1' });
    expect(shown).toHaveLength(1);

    // Fim de turno => "<agente> terminou" com a mesma tag por terminal (não empilha).
    notifier.observeEvent({ type: 'terminal.turn', name: 'dev-claude', owner: 'user', outcome: 'ended', workspaceId: 'w1' });
    expect(shown).toHaveLength(2);
    expect(shown[1]!.title).toBe('dev-claude terminou');
    expect(shown[1]!.options.tag).toBe('orquestra:w1:dev-claude');

    // Com a página visível => não notifica.
    visible = true;
    notifier.observeEvent({ type: 'terminal.state', name: 'revisor', state: 'busy', queued: 0, workspaceId: 'w1' });
    notifier.observeEvent({ type: 'terminal.state', name: 'revisor', state: 'waiting', queued: 0, workspaceId: 'w1' });
    notifier.observeEvent({ type: 'terminal.turn', name: 'revisor', owner: 'user', outcome: 'ended', workspaceId: 'w1' });
    expect(shown).toHaveLength(2);

    // Sem permissão => não notifica mesmo com página oculta.
    visible = false;
    permission = 'default';
    notifier.observeEvent({ type: 'terminal.state', name: 'outro', state: 'waiting', queued: 0, workspaceId: 'w2' });
    notifier.observeEvent({ type: 'terminal.turn', name: 'outro', owner: 'user', outcome: 'ended', workspaceId: 'w2' });
    expect(shown).toHaveLength(2);
  });

  it('seedSnapshot limpa chaves antigas do mesmo workspace, terminal.replaced limpa oldName e terminal.turn ignora owner broker', () => {
    const shown: Array<{ title: string; options: any }> = [];
    const notifier = new MobileNotifier({
      getPermission: () => 'granted',
      isPageVisible: () => false,
      showNotification: (title, options) => {
        shown.push({ title, options });
      },
    });

    // Primeiro snapshot: 'a' estava em 'waiting'
    notifier.seedSnapshot({
      workspaceId: 'w1',
      terminals: [{ name: 'a', state: 'waiting' }],
    });

    // Novo snapshot do mesmo workspace já não tem 'a', mas se 'a' voltar depois como waiting, deve notificar
    notifier.seedSnapshot({
      workspaceId: 'w1',
      terminals: [{ name: 'b', state: 'idle' }],
    });
    notifier.observeEvent({ type: 'terminal.state', name: 'a', state: 'waiting', queued: 0, workspaceId: 'w1' });
    expect(shown.map((s) => s.title)).toEqual(['a está esperando você']);

    // Renomear 'b' -> 'b-novo' remove a chave antiga 'b' (não confunde estado se 'b' for recriado em waiting)
    notifier.observeEvent({
      type: 'terminal.replaced',
      oldName: 'b',
      info: {
        name: 'b-novo',
        agent: 'claude',
        state: 'waiting',
        queued: 0,
        cwd: 'C:/p',
        resume: true,
        args: [],
        regente: false,
        monitor: false,
      },
      workspaceId: 'w1',
    });
    // Se 'b' estava 'waiting' antes e foi renomeado, limpar oldName garante estado limpo:
    notifier.observeEvent({
      type: 'terminal.replaced',
      oldName: 'b-novo',
      info: {
        name: 'b-final',
        agent: 'claude',
        state: 'idle',
        queued: 0,
        cwd: 'C:/p',
        resume: true,
        args: [],
        regente: false,
        monitor: false,
      },
      workspaceId: 'w1',
    });
    notifier.observeEvent({ type: 'terminal.state', name: 'b-novo', state: 'waiting', queued: 0, workspaceId: 'w1' });
    expect(shown.map((s) => s.title)).toEqual([
      'a está esperando você',
      'b-novo está esperando você',
    ]);

    // Turnos internos do broker (orq prompt) não geram notificação no celular
    notifier.observeEvent({ type: 'terminal.turn', name: 'b-final', owner: 'broker', outcome: 'ended', workspaceId: 'w1' });
    expect(shown).toHaveLength(2);
  });

  it('parseDeepLinkTarget extrai workspace e terminal da query string', () => {
    expect(parseDeepLinkTarget('')).toBeNull();
    expect(parseDeepLinkTarget('?pair=abc')).toBeNull();
    expect(parseDeepLinkTarget('?workspace=w1&terminal=dev-claude')).toEqual({ workspaceId: 'w1', terminal: 'dev-claude' });
  });
});

describe('PWA: manifest e service worker', () => {
  it('manifest.webmanifest tem nome Orquestra, display standalone, tema escuro e ícones 192 e 512', () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'Orquestra',
      short_name: 'Orquestra',
      display: 'standalone',
      start_url: '/',
      theme_color: '#0d0f13',
      background_color: '#0d0f13',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }),
        expect.objectContaining({ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }),
      ]),
    );
  });

  it('sw.js nunca intercepta /api ou /ws, não chama skipWaiting no install e abre/foca o terminal ao tocar na notificação', async () => {
    const swCode = readFileSync(join(publicDir, 'sw.js'), 'utf8');
    expect(swCode).not.toContain('skipWaiting');

    const listeners: Record<string, (event: any) => void> = {};
    const postMessage = vi.fn();
    const focus = vi.fn(async () => {});
    const openWindow = vi.fn(async () => {});
    let matchAllResult: any[] = [];
    const fakeSelf = {
      location: new URL('https://pc.tailnet.ts.net:8443/sw.js'),
      addEventListener: (type: string, fn: (event: any) => void) => {
        listeners[type] = fn;
      },
      clients: {
        matchAll: vi.fn(async () => matchAllResult),
        openWindow,
      },
    };
    const fakeCaches = {
      open: vi.fn(async () => ({ addAll: vi.fn(async () => {}), put: vi.fn(async () => {}) })),
      keys: vi.fn(async () => ['old-cache', 'orquestra-shell-v1']),
      delete: vi.fn(async () => true),
      match: vi.fn(async () => undefined),
    };

    new Function('self', 'caches', 'fetch', swCode)(fakeSelf, fakeCaches, vi.fn(async () => ({ ok: true, status: 200, clone: () => ({}) })));

    // /api e /ws nunca chamam respondWith
    for (const bypassed of [
      'https://pc.tailnet.ts.net:8443/api/me',
      'https://pc.tailnet.ts.net:8443/api/pair',
      'https://pc.tailnet.ts.net:8443/ws',
    ]) {
      const respondWith = vi.fn();
      listeners.fetch!({ request: { method: 'GET', url: bypassed, mode: 'cors' }, respondWith });
      expect(respondWith, bypassed).not.toHaveBeenCalled();
    }

    // Shell estático usa respondWith
    const respondWithStatic = vi.fn();
    listeners.fetch!({ request: { method: 'GET', url: 'https://pc.tailnet.ts.net:8443/icon-192.png', mode: 'no-cors' }, respondWith: respondWithStatic });
    expect(respondWithStatic).toHaveBeenCalledTimes(1);

    // notificationclick sem janela aberta => clients.openWindow('/?workspace=w1&terminal=revisor')
    let waitPromise: Promise<unknown> | undefined;
    listeners.notificationclick!({
      notification: { close: vi.fn(), data: { workspaceId: 'w1', terminal: 'revisor' } },
      waitUntil: (p: Promise<unknown>) => {
        waitPromise = p;
      },
    });
    await waitPromise;
    expect(openWindow).toHaveBeenCalledWith('/?workspace=w1&terminal=revisor');

    // notificationclick com janela já aberta => postMessage + focus
    matchAllResult = [{ url: 'https://pc.tailnet.ts.net:8443/', postMessage, focus }];
    listeners.notificationclick!({
      notification: { close: vi.fn(), data: { workspaceId: 'w2', terminal: 'arquiteto' } },
      waitUntil: (p: Promise<unknown>) => {
        waitPromise = p;
      },
    });
    await waitPromise;
    expect(postMessage).toHaveBeenCalledWith({
      type: 'orquestra:open-terminal',
      workspaceId: 'w2',
      terminal: 'arquiteto',
    });
    expect(focus).toHaveBeenCalled();
  });

  it('sw.js ignora requisições com Authorization, não grava Cache-Control: no-store e usa network-first para /manifest.webmanifest', async () => {
    const swCode = readFileSync(join(publicDir, 'sw.js'), 'utf8');
    const listeners: Record<string, (event: any) => void> = {};
    const cachePut = vi.fn(async () => {});
    const cacheMatch = vi.fn(async (key: unknown) =>
      key === '/manifest.webmanifest' ? { ok: true, status: 200, source: 'cached-manifest' } : { ok: true, status: 200, source: 'cached-static' },
    );
    const fakeSelf = {
      location: new URL('https://pc.tailnet.ts.net:8443/sw.js'),
      addEventListener: (type: string, fn: (event: any) => void) => {
        listeners[type] = fn;
      },
      clients: { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => {}) },
    };
    const fakeCaches = {
      open: vi.fn(async () => ({ addAll: vi.fn(async () => {}), put: cachePut })),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
      match: cacheMatch,
    };
    let fetchImpl: (req: any) => Promise<any> = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'Cache-Control': 'no-cache' }),
      clone: () => ({ cloned: true }),
    });

    new Function('self', 'caches', 'fetch', swCode)(fakeSelf, fakeCaches, (req: any) => fetchImpl(req));

    // Requisição com cabeçalho Authorization não é interceptada pelo SW
    const authRespondWith = vi.fn();
    listeners.fetch!({
      request: {
        method: 'GET',
        url: 'https://pc.tailnet.ts.net:8443/manifest.webmanifest',
        mode: 'cors',
        headers: new Headers({ Authorization: 'Bearer segredo' }),
      },
      respondWith: authRespondWith,
    });
    expect(authRespondWith).not.toHaveBeenCalled();

    // /manifest.webmanifest usa network-first mesmo havendo versão em cache
    let manifestPromise!: Promise<any>;
    listeners.fetch!({
      request: {
        method: 'GET',
        url: 'https://pc.tailnet.ts.net:8443/manifest.webmanifest',
        mode: 'cors',
        headers: new Headers(),
      },
      respondWith: (p: Promise<any>) => {
        manifestPromise = p;
      },
    });
    const freshManifest = await manifestPromise;
    expect(freshManifest.source).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(cachePut).toHaveBeenCalledWith('/manifest.webmanifest', { cloned: true });

    // Se a rede falhar em /manifest.webmanifest, usa o cache como fallback
    fetchImpl = async () => {
      throw new Error('offline');
    };
    listeners.fetch!({
      request: {
        method: 'GET',
        url: 'https://pc.tailnet.ts.net:8443/manifest.webmanifest',
        mode: 'cors',
        headers: new Headers(),
      },
      respondWith: (p: Promise<any>) => {
        manifestPromise = p;
      },
    });
    const fallbackManifest = await manifestPromise;
    expect(fallbackManifest.source).toBe('cached-manifest');

    // Resposta com Cache-Control: no-store nunca é gravada no cache
    cachePut.mockClear();
    cacheMatch.mockResolvedValueOnce(undefined as any);
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'Cache-Control': 'no-store' }),
      clone: () => ({ cloned: true }),
    });
    let noStorePromise!: Promise<any>;
    listeners.fetch!({
      request: {
        method: 'GET',
        url: 'https://pc.tailnet.ts.net:8443/assets/app.js',
        mode: 'no-cors',
        headers: new Headers(),
      },
      respondWith: (p: Promise<any>) => {
        noStorePromise = p;
      },
    });
    await noStorePromise;
    await new Promise((r) => setTimeout(r, 0));
    expect(cachePut).not.toHaveBeenCalled();
  });
});
