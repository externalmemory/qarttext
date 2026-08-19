// Cache-first shell so the app works with no network at all.
// Bump CACHE when any listed file changes.

const CACHE = 'hrqr-v3';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './src/qr.js',
  './src/matrix.js',
  './src/encode.js',
  './src/qart.js',
  './src/fonts.js',
  './src/layout.js',
  './src/generate.js',
  './src/variants.js',
  './src/render.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
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
    caches.match(request).then(hit => {
      if (hit) {
        // refresh in the background so a redeploy is picked up next visit
        fetch(request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(request, copy)); }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
