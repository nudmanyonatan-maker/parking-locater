/* ParkNearMe service worker.
 *
 * - Web Push: shows parking alerts. Understands both the Declarative Web Push
 *   shape sent by worker/push.ts ({web_push: 8030, notification: {...}}) and a
 *   plain {title, body, url, tag} payload. Always shows a notification (iOS
 *   revokes push permission for silent pushes).
 * - Notification taps focus an open app window (and route it in place) or open
 *   a new one.
 * - Minimal offline shell: navigations are network-first with the cached shell
 *   as fallback. Install caches the shell and the hashed build assets it
 *   references (the first page load happens before this worker controls it);
 *   other assets are cached on first use. /api/* is never cached — live
 *   parking data must never come from a cache.
 */

const SHELL_CACHE = 'pnm-shell-v1';
const ASSET_CACHE = 'pnm-assets-v1';
const MAX_ASSETS = 40;
const ICON = '/icons/icon-192.png';
/** Monochrome (white on transparent) for Android's status bar. */
const BADGE = '/icons/badge-96.png';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precacheShell().catch(() => undefined));
});

/** Cache '/' and its /assets/* files, so the app opens offline even after a single online launch. */
async function precacheShell() {
  const res = await fetch(new Request('/', { cache: 'reload' }));
  if (!res.ok) return;
  await (await caches.open(SHELL_CACHE)).put('/', res.clone());
  const html = await res.text();
  const urls = [...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]))];
  if (urls.length) await (await caches.open(ASSET_CACHE)).addAll(urls);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('pnm-') && !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }
  // Vite emits content-hashed files under /assets/, so a cached copy is never outdated.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(req));
  }
});

async function networkFirstShell(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches
        .open(SHELL_CACHE)
        .then((c) => c.put('/', copy))
        .catch(() => undefined);
    }
    return res;
  } catch (err) {
    const cached = await caches.match('/', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(req) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') {
    await cache.put(req, res.clone());
    // Old deploys' assets pile up; keep the cache small (oldest entries first).
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
  }
  return res;
}

/** Only same-origin paths may be opened from a notification. */
function safePath(value) {
  if (typeof value !== 'string' || !value) return '/';
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

function parsePush(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    if (data && typeof data === 'object') {
      // Declarative Web Push (worker/push.ts buildPayload).
      if (data.notification && typeof data.notification === 'object') {
        const n = data.notification;
        return {
          title: n.title,
          body: n.body,
          tag: n.tag,
          url: (n.data && n.data.path) || n.navigate,
        };
      }
      return data;
    }
  } catch {
    // Not JSON: treat the payload as the body text.
  }
  try {
    return { body: event.data.text() };
  } catch {
    return {};
  }
}

self.addEventListener('push', (event) => {
  const msg = parsePush(event);
  const title = typeof msg.title === 'string' && msg.title ? msg.title : 'Parking Locator';
  const body = typeof msg.body === 'string' && msg.body ? msg.body : 'Possible parking near home. Open the app to check.';
  const tag = typeof msg.tag === 'string' && msg.tag ? msg.tag : 'pnm-parking';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: ICON,
      badge: BADGE,
      timestamp: Date.now(),
      data: { url: safePath(msg.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // The app routes in place (see src/main.tsx); no full reload.
        client.postMessage({ type: 'navigate', url: path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
