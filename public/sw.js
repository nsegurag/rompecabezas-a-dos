// Service worker: permite instalar la app y abrirla rápido.
// Las páginas y el código se piden primero a la red (así siempre ves la última versión)
// y solo si no hay conexión se usa la copia guardada.
const CACHE = 'rz-v4';
const SHELL = ['/', '/css/styles.css', '/js/main.js', '/js/game.js', '/js/geometry.js', '/js/cropper.js', '/js/net.js', '/js/rtc.js', '/js/timelapse.js',
  '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/health') return;
  // Fotos de rompecabezas: nunca cambian, se guardan al primer uso.
  if (url.pathname.startsWith('/img/')) {
    e.respondWith(caches.open(CACHE).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/' : req, copy)); }
    return r;
  }).catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req)) || Response.error()));
});
