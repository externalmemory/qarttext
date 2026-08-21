// Offline shell.
//
// Deliberately network-first, not cache-first. A cache-first worker with a
// background refresh always shows the *previous* deploy on the first load
// after a change, and can serve a stale script alongside fresh markup, which
// breaks in confusing ways. Correctness beats the few milliseconds that
// serving from cache would save on an app this small.
//
// Bump BUILD whenever the shell changes; it names the cache and is shown in
// the page footer so it is obvious which version is actually loaded.
const BUILD = '2026-08-21.2';
const CACHE = `hrqr-${BUILD}`;

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './src/qr.js',
  './src/matrix.js',
  './src/encode.js',
  './src/qart.js',
  './src/fonts.js',
  './src/layout.js',
  './src/payload.js',
  './src/install.js',
  './src/generate.js',
  './src/variants.js',
  './src/render.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // bypass the HTTP cache: precaching a stale copy would defeat the point
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      // offline: fall back to whatever was cached, and to the shell for navigation
      .catch(() => caches.match(request).then(hit =>
        hit ?? (request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
