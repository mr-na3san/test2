const cacheName = 'livescan-v1';
const assets = ['./', './index.html', './style.css', './script.js', './manifest.json', './logo.png', './offline.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(cacheName).then(c => c.addAll(assets)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== cacheName).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('cdn.jsdelivr') || e.request.url.includes('fonts.')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./offline.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
