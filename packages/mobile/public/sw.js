const CACHE_NAME = 'orquestra-shell-v1';
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

function isBypassedPath(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/ws' ||
    pathname.startsWith('/ws/') ||
    pathname === '/sw.js'
  );
}

function canCacheResponse(res) {
  if (!res || !res.ok || res.status !== 200) return false;
  const cacheControl =
    res.headers && typeof res.headers.get === 'function' ? res.headers.get('cache-control') || '' : '';
  return !cacheControl.toLowerCase().includes('no-store');
}

self.addEventListener('install', (event) => {
  // Atualização segura: aguarda a próxima abertura do aplicativo para assumir,
  // sem misturar assets em uso durante a sessão aberta.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers && typeof req.headers.get === 'function' && req.headers.get('authorization')) return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  const isNavigation = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const isManifest = url.pathname === '/manifest.webmanifest';
  if (isNavigation || isManifest) {
    const cacheKey = isManifest ? '/manifest.webmanifest' : '/';
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (canCacheResponse(res)) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(cacheKey);
          if (cached) return cached;
          throw new Error('Sem conexão e sem shell em cache.');
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (canCacheResponse(res)) {
          const copy = res.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : '';
  const terminal = typeof data.terminal === 'string' ? data.terminal : '';
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspace', workspaceId);
  if (terminal) params.set('terminal', terminal);
  const targetUrl = params.toString() ? `/?${params.toString()}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            client.postMessage({
              type: 'orquestra:open-terminal',
              workspaceId: workspaceId || undefined,
              terminal: terminal || undefined,
            });
            if ('focus' in client) {
              await client.focus();
            }
            return;
          }
        } catch {}
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    }),
  );
});
