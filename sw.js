/*
 * Offline support for the CoolTeck Field Guide.
 *  - App files: served from the phone at once, refreshed in the background.
 *  - content.json: internet first, but the saved copy is used if the internet is slow (4 s) or off.
 *  - media/: saved on first use and served from the phone after that (file names change when a file
 *    changes, so a saved file never goes stale). Videos support range requests for playback.
 * Cache names must match assets/app.js.
 */
const SHELL = 'cft-shell-v5';
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
  ev.waitUntil(caches.keys().then(async keys => {
    const old = keys.filter(k => /^cft-shell-/.test(k) && k !== SHELL);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    if (old.length) await tellPagesUpdated();     // a real update, not the first visit
  }));
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
  if (path.endsWith('/content/content.json')) { ev.respondWith(contentFirst(ev, url.origin + path)); return; }
  if (path.indexOf('/media/') !== -1) { ev.respondWith(media(ev, req, url.origin + path)); return; }
  const scope = new URL(self.registration.scope);
  if (req.mode === 'navigate') {
    // Only the guide itself opens from the phone; other pages (e.g. tools/) load normally.
    if (path === scope.pathname || path === scope.pathname + 'index.html') ev.respondWith(shell(ev, req, scope.href));
    return;
  }
  if (path.indexOf(scope.pathname + 'tools/') === 0 || path.indexOf(scope.pathname + 'editor/') === 0) return;
  ev.respondWith(shell(ev, req, url.origin + path));
});

/**
 * Saved app file at once; a fresh copy is fetched in the background. When the site has a newer
 * version of a file, it is SAVED FIRST and then the pages are told to reload (once, after all the
 * app files of that visit have been checked), so the reload gets the new files.
 */
async function shell(ev, req, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key);
  const hitCopy = hit ? hit.clone() : null;   // the page reads `hit`; compare against a separate copy
  const fresh = fetch(req.mode === 'navigate' ? key : req.url, { cache: 'no-cache' }).then(async res => {
    if (res.ok) {
      // GitHub Pages gives every file a new ETag on each deploy (even a content-only publish), so the
      // file's bytes are compared instead.
      const changed = hitCopy ? !(await sameBytes(hitCopy, res.clone())) : false;
      if (!hit || changed) {
        try { await cache.put(key, res.clone()); } catch (e) { return res; }
      }
      if (changed) await tellSoon();
    }
    return res;
  });
  ev.waitUntil(fresh.catch(() => {}));   // keep the worker alive until the new copy is saved
  if (hit) return hit;
  return fresh;
}

async function sameBytes(a, b) {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x), v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}

/** One "updated" message for several changed files: sent when no other change arrives for 800 ms. */
let tellTimer = null, tellBatch = null;
function tellSoon() {
  clearTimeout(tellTimer);
  if (!tellBatch) { let done; tellBatch = { p: new Promise(r => { done = r; }), done: null }; tellBatch.done = done; }
  const batch = tellBatch;
  tellTimer = setTimeout(async () => {
    if (tellBatch === batch) tellBatch = null;
    await tellPagesUpdated();
    batch.done();
  }, 800);
  return batch.p;
}

/** Fresh content when the internet answers within a few seconds, otherwise the saved copy. */
async function contentFirst(ev, key) {
  const cache = await caches.open(CONTENT);
  const net = fetch(key, { cache: 'no-store' }).then(async res => {
    if (res.ok) await cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  ev.waitUntil(net.catch(() => {}));
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
const downloading = {};
async function media(ev, req, key) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(key);
  const range = req.headers.get('range');
  if (hit) return range ? partial(hit, range) : hit;
  if (range) {
    // Players (and iPhones in particular) need a real 206 answer: download and save the whole file
    // once, then answer from the saved copy.
    downloading[key] = downloading[key] || fetch(key).then(async res => {
      if (res.ok) { try { await cache.put(key, res.clone()); } catch (e) { /* storage full */ } }
      return res;
    }).finally(() => { setTimeout(() => { delete downloading[key]; }, 0); });
    ev.waitUntil(downloading[key].catch(() => {}));
    const res = await downloading[key];
    if (!res.ok) return res;
    const saved = await cache.match(key);
    return partial(saved || res.clone(), range);
  }
  // Not saved yet and no range: stream it to the page while it is being saved (download progress).
  const res = await fetch(key);
  if (!res.ok) return res;
  ev.waitUntil(cache.put(key, res.clone()).catch(() => { /* phone storage full: still show it */ }));
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
