/* Repair Desk service worker.
   CACHE number MUST equal APP_VERSION in index.html — bump both together.
   cheungeric02.github.io is shared by several apps, so this worker only ever deletes its OWN old caches. */
const CACHE = 'rd-shell-v5';
const CDN_CACHE = 'rd-cdn-v1';     // pinned-version libraries (Firebase SDK, Leaflet) so the app starts with no signal
const SHARE_CACHE = 'rd-share';    // holds a shared text until the page creates the job (or the intake is closed)
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const CDN_PREFIXES = [
  'https://www.gstatic.com/firebasejs/10.12.5/',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/'
];
const CDN = [
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];
const NET_TIMEOUT = 4000;          // weak signal: fall back to the cached copy after this long

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))),
    // best effort — one failed library must not stop the app from installing
    caches.open(CDN_CACHE).then(c => Promise.all(CDN.map(u => c.add(u).catch(() => {}))))
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('rd-shell-') && k !== CACHE).map(k => caches.delete(k))))
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

  if (req.method !== 'GET') return;

  // Pinned CDN libraries never change at a given version: cache first.
  if (CDN_PREFIXES.some(p => req.url.startsWith(p))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CDN_CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Everything else off-origin (Firebase, map tiles, geocoding) goes straight to the network.
  if (url.origin !== scope.origin) return;

  // Same-origin: network first so updates arrive promptly, but on a weak signal fall back to the cached
  // copy after NET_TIMEOUT (keep waiting for the network if nothing is cached).
  e.respondWith((async () => {
    const cachedP = caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined));
    const net = fetch(req).then(res => {
      if (res.ok && !url.search) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    });
    net.catch(() => {});
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), NET_TIMEOUT); });
    try {
      const first = await Promise.race([net, timeout]);
      if (first !== 'timeout') { clearTimeout(timer); return first; }
      const cached = await cachedP;
      return cached || await net;
    } catch (err) {
      clearTimeout(timer);
      return (await cachedP) || Response.error();
    }
  })());
});
