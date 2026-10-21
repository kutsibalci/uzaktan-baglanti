// Service worker: yalnızca uygulama kabuğunu (sayfa, betik, stil, ikonlar) önbelleğe alır.
// AĞ ÖNCELİKLİ: her istek önce sunucuya gider, önbellek yalnızca sunucuya ulaşılamazsa kullanılır;
// böylece güncellemeler hemen gelir. /api/*, özellik betikleri ve diğer her şey hiç ele alınmaz (WebSocket zaten geçmez).
const CACHE = 'uzak-kabuk-v2';
const SHELL = [
  './', 'index.html', 'app.js', 'ikon.js', 'dokunmatik.js', 'ekranlar.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const scopePath = new URL(self.registration.scope).pathname; // genelde "/"
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Biri inemezse kurulum yine de tamamlansın.
    await Promise.all(SHELL.map((p) => cache.add(new Request(p, { cache: 'no-cache' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.search) return;
  if (!SHELL_PATHS.has(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Sunucu "Cache-Control: no-cache" gönderiyor; ayrıca seçenek verilmez (navigate isteğine RequestInit verilemez).
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(url.pathname, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      // Çevrimdışı: kabuğun son kopyası (sayfa yeniden bağlanmayı kendisi dener).
      const hit = await cache.match(url.pathname) || (req.mode === 'navigate' ? await cache.match(scopePath) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
