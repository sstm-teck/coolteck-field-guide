/*
 * Offline support for the CoolTeck Field Guide.
 *  - App files: served from the phone at once, refreshed in the background.
 *  - content.json: internet first, but the saved copy is used if the internet is slow (4 s) or off.
 *  - media/: saved on first use and served from the phone after that (file names change when a file
 *    changes, so a saved file never goes stale). Videos support range requests for playback.
 * Cache names must match assets/app.js.
 */
const SHELL = 'cft-shell-v3';
const CONTENT = 'cft-content-v1';
const MEDIA = 'cft-media-v1';
const SHELL_FILES = [
  './', 'index.html', 'assets/style.css', 'assets/app.js', 'manifest.webmanifest',
  'assets/icons/mark-96.png', 'assets/icons/favicon-48.png', 'assets/icons/icon-192.png',
];
const CONTENT_TIMEOUT_MS = 4000;

// GitHub Pages tells browsers to keep files for 10 minutes; 'reload' / 'no-cache' skip that
// browser copy so the phone always gets the newest app files from the site.
self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => /^cft-shell-/.test(k) && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(tellPagesUpdated));
});

/** Asks open pages to reload; they do it on the jobs or models screen, never in the middle of a guide. */
async function tellPagesUpdated() {
  (await self.clients.matchAll({ type: 'window' })).forEach(c => c.postMessage({ type: 'updated' }));
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.endsWith('/content/content.json')) { ev.respondWith(contentFirst(url.origin + path)); return; }
  if (path.indexOf('/media/') !== -1) { ev.respondWith(media(req, url.origin + path)); return; }
  const scope = new URL(self.registration.scope);
  if (req.mode === 'navigate') {
    // Only the guide itself opens from the phone; other pages (e.g. tools/) load normally.
    if (path === scope.pathname || path === scope.pathname + 'index.html') ev.respondWith(shell(req, scope.href));
    return;
  }
  if (path.indexOf(scope.pathname + 'tools/') === 0 || path.indexOf(scope.pathname + 'editor/') === 0) return;
  ev.respondWith(shell(req, url.origin + path));
});

/**
 * Saved app file at once; a fresh copy is fetched in the background. When the site has a newer
 * version of the file, the pages are told to reload.
 */
async function shell(req, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key);
  const fresh = fetch(req.mode === 'navigate' ? key : req.url, { cache: 'no-cache' }).then(res => {
    if (res.ok) {
      cache.put(key, res.clone()).catch(() => {});
      const was = hit && (hit.headers.get('etag') || hit.headers.get('last-modified'));
      const now = res.headers.get('etag') || res.headers.get('last-modified');
      if (was && now && was !== now) tellPagesUpdated();
    }
    return res;
  });
  if (hit) { fresh.catch(() => {}); return hit; }
  return fresh;
}

/** Fresh content when the internet answers within a few seconds, otherwise the saved copy. */
async function contentFirst(key) {
  const cache = await caches.open(CONTENT);
  const net = fetch(key, { cache: 'no-store' }).then(res => {
    if (res.ok) cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  const saved = await cache.match(key);
  if (!saved) return net;
  const timer = new Promise(resolve => setTimeout(() => resolve(null), CONTENT_TIMEOUT_MS));
  try {
    const res = await Promise.race([net, timer]);
    if (res && res.ok) return res;
  } catch (e) { /* offline */ }
  net.catch(() => {});
  return saved;
}

/** Pictures, videos and sounds: from the phone when saved, otherwise downloaded and saved. */
async function media(req, key) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(key);
  const range = req.headers.get('range');
  if (hit) return range ? partial(hit, range) : hit;
  // Not saved yet: download the whole file (even when a player asked for a range) and stream it to
  // the page while it is being saved, so the page can show download progress.
  const res = await fetch(key);
  if (!res.ok) return res;
  cache.put(key, res.clone()).catch(() => { /* phone storage full: still show it */ });
  return res;
}

/** A 206 slice of a saved file, for video players that ask for byte ranges. */
async function partial(res, range) {
  const blob = await res.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = blob.size;
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || blob.type || 'application/octet-stream',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
