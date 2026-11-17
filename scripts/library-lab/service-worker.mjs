/* Classic worker emitted by build.mjs with a verified LIBRARY_BUILD manifest. */
/* CacheStorage never receives API responses, account data or audio bytes. */
const CACHE_PREFIX = 'mhub-library-shell-';
const CACHE_NAME = CACHE_PREFIX + LIBRARY_BUILD.release;
const SHELL_URL = '/library/';
const FILES = new Map(LIBRARY_BUILD.files.map(file => [file.url, file]));

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function installShell() {
  const cache = await caches.open(CACHE_NAME);
  try {
    for (const file of LIBRARY_BUILD.files) {
      // A logged-in tab must never make account-dependent content persistent.
      const request = new Request(file.url, { credentials: 'omit', cache: 'reload', redirect: 'error' });
      const response = await fetch(request);
      if (response.status !== 200 || response.type === 'opaque' || response.headers.has('set-cookie')) throw new Error('Invalid shell response');
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes(file.type)) throw new Error('Unexpected shell content type');
      const bytes = await response.clone().arrayBuffer();
      if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error('Shell integrity check failed');
      await cache.put(new Request(file.url, { credentials: 'omit' }), response);
    }
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
  // Updates stay waiting. A page must explicitly request activation when idle.
}

self.addEventListener('install', event => event.waitUntil(installShell()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function cachedShell(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const key = request.mode === 'navigate' ? SHELL_URL : url.pathname;
  const response = await cache.match(key);
  if (response) return response;
  return fetch(request);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range') || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (!['/library/', '/library/index.html'].includes(url.pathname)) return;
  } else if (!FILES.has(url.pathname) || url.search || url.hash) {
    return;
  }
  event.respondWith(cachedShell(request, url));
});

async function clientReady(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 2000);
    channel.port1.onmessage = event => {
      clearTimeout(timeout); channel.port1.close(); resolve(event.data?.ready === true);
    };
    client.postMessage({ type: 'LIBRARY_UPDATE_CHECK' }, [channel.port2]);
  });
}

async function activateIfIdle(event) {
  const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter(client => new URL(client.url).pathname.startsWith('/library/'));
  const ready = clients.length > 0 && (await Promise.all(clients.map(clientReady))).every(Boolean);
  event.ports[0]?.postMessage({ activated: ready, reason: ready ? null : 'busy-tab' });
  if (ready) await self.skipWaiting();
}

self.addEventListener('message', event => {
  if (event.data?.type === 'LIBRARY_SHELL_STATUS') {
    event.ports[0]?.postMessage({ release: LIBRARY_BUILD.release, cacheName: CACHE_NAME });
  } else if (event.data?.type === 'LIBRARY_ACTIVATE_UPDATE') {
    event.waitUntil(activateIfIdle(event));
  } else if (event.data?.type === 'LIBRARY_PRUNE_SHELLS') {
    event.waitUntil((async () => {
      // Only retire old *page* caches once there are no other library windows.
      // Audio IndexedDB and caches belonging to the combined app are untouched.
      if (self.registration.installing || self.registration.waiting) return;
      const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter(client => new URL(client.url).pathname.startsWith('/library/'));
      if (windows.length !== 1 || windows[0].id !== event.source?.id) return;
      if (event.data.release !== LIBRARY_BUILD.release) return;
      for (const name of await caches.keys()) {
        if (self.registration.installing || self.registration.waiting) return;
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
      }
    })());
  }
});
