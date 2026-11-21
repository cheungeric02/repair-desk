/* Repair Desk service worker.
   CACHE number MUST equal APP_VERSION in index.html — bump both together. */
const CACHE = 'rd-shell-v2';
const SHARE_CACHE = 'rd-share';   // holds a shared text until the page picks it up
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);

  // Android "Share → Repair Desk": stash the text, then open the app. Kept out of the URL on purpose.
  if (req.method === 'POST' && url.origin === scope.origin && url.pathname === scope.pathname + 'share-target') {
    e.respondWith((async () => {
      let text = '';
      try {
        const fd = await req.formData();
        const parts = [];
        for (const k of ['title', 'text', 'url']) {
          const v = (fd.get(k) || '').toString().trim();
          if (v && !parts.includes(v)) parts.push(v);
        }
        text = parts.join('\n');
      } catch (err) { /* fall through with empty text */ }
      const c = await caches.open(SHARE_CACHE);
      await c.put(new URL('__shared', scope).href,
        new Response(JSON.stringify({ text, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
      return Response.redirect(new URL('./?shared=1', scope).href, 303);
    })());
    return;
  }

  // Only same-origin GETs; Firebase, map tiles, geocoding etc. go straight to the network.
  if (req.method !== 'GET' || url.origin !== scope.origin) return;

  // Network first (so updates arrive promptly), cached copy when offline.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && !url.search) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined))
      .then(r => r || Response.error()))
  );
});
