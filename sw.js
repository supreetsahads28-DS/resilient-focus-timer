// Service worker for Resilient Focus Timer.
//
// Scope is deliberately narrow: this only caches the *app shell* (the built
// JS/CSS bundle, the HTML shell, the manifest and icons) so the app can
// install as a PWA and open while offline. It never touches API routes
// (/auth, /sessions, /analytics) — those must always hit the network so the
// timer, history and analytics stay correct. Caching session data here would
// silently reintroduce the "stale data" bugs the app's own resilience layer
// (see docs/TEST_RESULTS_BUGFIXES.md) was written to fix.

const CACHE_VERSION = 'rft-shell-v1';
const SHELL_URL = '/'; // all app routes (/, /login, /signup, /history) serve the same index.html

const API_PREFIXES = ['/auth', '/sessions', '/analytics'];

self.addEventListener('install', (event) => {
  // Activate this version as soon as it's installed, rather than waiting
  // for all tabs of the old version to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isApiRequest(url) {
  return API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET requests are ever cached; everything else (POST/PATCH to the
  // API) passes straight through untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept API calls — always go to the network so session state,
  // history and analytics are never served stale.
  if (isApiRequest(url)) return;

  // Full-page navigations (/, /login, /signup, /history): network-first, so
  // a signed-in user always gets the freshest shell, with a cached fallback
  // for when they're offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          cache.put(SHELL_URL, response.clone());
          return response;
        } catch (err) {
          const cache = await caches.open(CACHE_VERSION);
          const cached = await cache.match(SHELL_URL);
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Hashed build assets (/assets/...) are content-addressed and immutable,
  // so they're safe to cache-first forever.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        cache.put(request, response.clone());
        return response;
      })()
    );
    return;
  }

  // Everything else (manifest, icons): cache-first with a network fallback,
  // refreshing the cache in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          cache.put(request, response.clone());
          return response;
        })
        .catch(() => undefined);
      return cached || (await networkFetch) || Response.error();
    })()
  );
});
