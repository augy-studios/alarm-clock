/* Bump VERSION on every deploy that changes anything this worker serves.
   The browser only sees an update when this file changes byte for byte, so a
   forgotten bump means nobody gets the new version or the update bar. */
const VERSION = "2026-09-24.1";
const CACHE = `alarm-${VERSION}`;

// Not "/index.html": cleanUrls redirects it to "/", and a redirected response
// cannot answer a navigation.
const ASSETS = [
  "/",
  "/style.css",
  "/script.js",
  "/app.js",
  "/js/theme.js",
  "/js/icons.js",
  "/js/ui.js",
  "/js/update.js",
  "/XAC-192.png",
  "/XAC-512.png",
  "/favicon.ico",
  "/manifest.json"
];

// Fonts live outside the versioned cache so a deploy does not throw them
// away and leave an offline reader on the fallback font.
const FONT_CACHE = "alarm-fonts";
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* -- Install: cache shell. No skipWaiting here: the new worker waits until
      somebody presses Reload in the update bar. -- */

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
    // cache: 'reload' so the precache skips the HTTP cache and gets this deploy.
    .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
  );
});

/* -- Activate: clean old caches. No clients.claim here either. -- */

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
    .then(keys =>
      Promise.all(
        keys
        .filter(k => k !== CACHE && k !== FONT_CACHE)
        .map(k => caches.delete(k))
      )
    )
  );
});

/* -- Message: the only place skipWaiting or claim is ever called -- */

self.addEventListener('message', (event) => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;

  if (type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

/* -- Notification click: bring the app forward -- */

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      const client = clients.find(c => new URL(c.url).origin === self.location.origin);
      return client ? client.focus() : self.clients.openWindow('/');
    })
  );
});

/* -- Fetch: strategy per route -- */

self.addEventListener('fetch', event => {
  const {
    request
  } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // API - network-first
  if (sameOrigin && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Google Fonts - cache-first (immutable)
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // Anything else cross-origin (analytics, ads) goes straight to the network,
  // never into the cache.
  if (!sameOrigin) return;

  // Pages - the cached shell, whatever the query string
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }

  // static assets - cache-first
  event.respondWith(cacheFirst(request));
});

/* -- Strategies -- */

// Reads this version's cache only. caches.match() would search every cache,
// including a newer worker's that is still waiting.
async function fromCache(request, options, cacheName = CACHE) {
  const cache = await caches.open(cacheName);
  return cache.match(request, options);
}

async function navigation(request) {
  const cached = await fromCache(request, { ignoreSearch: true });
  if (cached) return cached;

  try {
    return await fetch(request);
  } catch {
    // offline - fall back to the app shell
    return (await fromCache('/')) || new Response('Offline', {
      status: 503
    });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'You appear to be offline.'
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json'
        },
      }
    );
  }
}

async function cacheFirst(request, cacheName = CACHE) {
  const cached = await fromCache(request, undefined, cacheName);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', {
      status: 503
    });
  }
}
