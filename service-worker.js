const CACHE = 'personal-cabinet-v1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(r => { if (r.ok && new URL(event.request.url).origin === self.location.origin) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); } return r; })));
});
