/* Hardband Photos service worker: caches the app shell so the app opens offline.
   Bump VERSION whenever app files change so phones pick up the new copy. */
const VERSION = 'hbp-v7';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './sync.js',
  './config.js',
  './styles.css',
  './manifest.webmanifest',
  './vendor/jszip.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first (fast + offline), with a background refresh of the cached copy.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // team-library (Supabase) calls always go to the network

  // config.js: network first so a newly pasted project URL/key is picked up right away; cached copy when offline.
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put('./index.html', res.clone()));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
