// Offline support. App code: network-first (so updates arrive), falling back
// to cache. Bird audio and photos: cache-first.
const VERSION = 'fledgling-v1';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/analysis.js', 'js/match.js', 'js/store.js', 'js/wav.js', 'js/spectrogram.js', 'js/worklet.js',
  'data/birds.json', 'icons/icon.svg', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE);
    // Pre-cache every bird's call + photo so the field guide works offline.
    try {
      const db = await (await fetch('data/birds.json')).json();
      const extra = [];
      for (const b of db.birds) {
        if (b.clip) extra.push(`audio/${b.id}.m4a`);
        if (b.photo) extra.push(`img/${b.id}.jpg`);
      }
      await Promise.all(extra.map(u => c.add(u).catch(() => {})));
    } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isMedia = /\/(audio|img)\//.test(req.url);
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    if (isMedia) {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch {
      return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html'));
    }
  })());
});
