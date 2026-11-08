/*
 * CoolTeck Field Guide (دليل الفني).
 * Screens: job (#/) -> model (#/<job>) -> steps (#/<job>/<model>/<n>) -> done (#/<job>/<model>/done).
 * Every step has its own link. Opening a guide saves all its pictures, videos and sounds on the phone,
 * so it can be opened at home and used on site with weak or no internet.
 * Content comes from content/content.json, written by the admin editor.
 */
(function () {
  'use strict';

  const CONTENT_URL = 'content/content.json';
  const MEDIA_CACHE = 'cft-media-v1';      // must match sw.js
  const CONTENT_CACHE = 'cft-content-v1';  // must match sw.js

  // ---------------------------------------------------------------- icons
  const I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
    // Right-to-left: "next" points left, "back" points right.
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 5l-7 7 7 7"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9Z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20Z" fill="currentColor" fill-opacity=".12"/><path d="M12 9v5M12 17.5h.01"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    saved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M7 9l5 5 5-5M5 20h14"/></svg>',
    offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.2-1.6M1.5 9.5a15 15 0 0 1 4.2-2.7M22.5 9.5A15 15 0 0 0 10.7 5.6M12 20h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>',
  };

  // ---------------------------------------------------------------- helpers
  const $ = sel => document.querySelector(sel);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => Number(n).toLocaleString('ar-EG');
  const abs = u => new URL(u, location.href).href;

  let C = null;          // content in use
  let pending = null;    // newer content, applied when the worker is back on the first screen
  let userTap = false;   // the screen was opened by a tap (browsers only play sound after a tap)

  const opById = id => (C.operations || []).find(o => o.id === id);
  const modelById = id => (C.models || []).find(m => m.id === id);
  const modelsFor = op => (op.models || []).map(modelById).filter(Boolean);
  /** Steps of a job for one model: steps with no model list apply to every model. */
  const stepsFor = (opId, modelId) => ((C.steps || {})[opId] || [])
    .filter(s => !s.models || !s.models.length || s.models.indexOf(modelId) !== -1);
  const mediaOf = s => [s.image, s.video, s.audio].filter(Boolean);
  function allMedia() {
    const out = [];
    const add = u => { if (u) out.push(abs(u)); };
    (C.operations || []).forEach(o => { add(o.image); add(o.audio); });
    (C.models || []).forEach(m => { add(m.image); add(m.audio); });
    Object.keys((C.app && C.app.prompts) || {}).forEach(k => add(C.app.prompts[k].audio));
    Object.keys(C.steps || {}).forEach(k => C.steps[k].forEach(s => mediaOf(s).forEach(add)));
    return Array.from(new Set(out));
  }

  // ---------------------------------------------------------------- saving on the phone
  // Everything opened is kept. Pictures of the first two screens are saved at start; a guide's
  // media is saved when the guide is opened. Old files no longer in the content are removed.
  async function cacheUrls(urls, onProgress) {
    if (!window.caches) return false;
    const cache = await caches.open(MEDIA_CACHE);
    let done = 0, ok = true;
    for (const u of urls) {
      try {
        if (!(await cache.match(u))) {
          const res = await fetch(u);
          if (!res.ok) throw new Error(res.status);
          try {
            await cache.put(u, res.clone());
          } catch (e) {          // phone storage full: drop files that are no longer used, try once more
            await removeUnused();
            await cache.put(u, res.clone());
          }
        }
      } catch (e) {
        ok = false;
      }
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
    return ok;
  }
  async function isCached(urls) {
    if (!window.caches) return false;
    const cache = await caches.open(MEDIA_CACHE);
    for (const u of urls) if (!(await cache.match(u))) return false;
    return true;
  }
  async function removeUnused() {
    if (!window.caches || !C) return;
    const keep = new Set(allMedia());
    const cache = await caches.open(MEDIA_CACHE);
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  }

  // ---------------------------------------------------------------- content
  async function readCachedContent() {
    try {
      const res = window.caches && await (await caches.open(CONTENT_CACHE)).match(abs(CONTENT_URL));
      return res ? await res.json() : null;
    } catch (e) { return null; }
  }
  async function fetchContent() {
    const res = await fetch(CONTENT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('content ' + res.status);
    const copy = res.clone();
    const data = await res.json();
    try { if (window.caches) await (await caches.open(CONTENT_CACHE)).put(abs(CONTENT_URL), copy); } catch (e) { /* storage full */ }
    return data;
  }
  async function loadContent() {
    try {
      C = await fetchContent();
    } catch (e) {
      C = await readCachedContent();
    }
    if (!C) return false;
    cacheUrls(firstScreensMedia());
    removeUnused();
    return true;
  }
  function firstScreensMedia() {
    return [].concat((C.operations || []).map(o => o.image), (C.models || []).map(m => m.image)).filter(Boolean).map(abs);
  }
  /** Quietly checks for newer content when the phone is back online or the app is reopened. */
  async function checkForUpdate() {
    if (!C || !navigator.onLine) return;
    try {
      const fresh = await fetchContent();
      if (fresh.version === C.version) return;
      pending = fresh;
      if (route().page === 'home') applyPending();
    } catch (e) { /* stay on the saved copy */ }
  }
  function applyPending() {
    if (!pending) return;
    C = pending; pending = null;
    cacheUrls(firstScreensMedia());
    removeUnused();
    render();
  }

  // ---------------------------------------------------------------- sound
  const player = new Audio();
  let playingBtn = null;
  function stopSound() {
    player.pause();
    if (playingBtn) { playingBtn.classList.remove('playing'); playingBtn.innerHTML = I.speaker; playingBtn = null; }
  }
  function playSound(src, btn) {
    stopSound();
    if (!src) return;
    player.src = src;
    player.play().then(() => {
      playingBtn = btn || null;
      if (btn) { btn.classList.add('playing'); btn.innerHTML = I.stop; }
    }, () => { /* blocked until the worker taps; the speaker button still works */ });
  }
  player.addEventListener('ended', stopSound);
  const speakBtn = src => src ? '<button class="speak" data-act="speak" data-src="' + esc(src) + '" aria-label="اسمع">' + I.speaker + '</button>' : '';

  // ---------------------------------------------------------------- routing
  // #/                     -> jobs
  // #/<job>                -> models of the job (skipped when the job has one model)
  // #/<job>/<model>/<n>    -> step n
  // #/<job>/<model>/done   -> finished
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return { page: 'home' };
    if (parts.length === 1) return { page: 'models', op: parts[0] };
    if (parts[2] === 'done') return { page: 'done', op: parts[0], model: parts[1] };
    return { page: 'step', op: parts[0], model: parts[1], n: Math.max(1, parseInt(parts[2], 10) || 1) };
  }
  const link = (...p) => '#/' + p.map(encodeURIComponent).join('/');
  function go(hash) { userTap = true; location.hash = hash; }
  function replace(hash) { history.replaceState(null, '', hash); render(); }

  // ---------------------------------------------------------------- header and bars
  function renderTop(title, sub) {
    const app = C.app || {};
    $('#top').innerHTML = title
      ? '<button class="round" data-act="home" aria-label="الرئيسية">' + I.home + '</button>' +
        '<div class="brand"><div><div class="t">' + esc(title) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div></div>'
      : '<div class="brand"><img src="assets/icons/mark-96.png" alt=""><div><div class="t">' + esc(app.title || 'دليل الفني') + '</div>' +
        '<div class="s">' + esc(app.subtitle || '') + '</div></div></div>';
  }
  function renderNote() {
    const notes = [];
    if (!navigator.onLine) notes.push(I.offline + '<span>مفيش نت · شغّال من اللي متحفظ</span>');
    const bar = $('#noteBar');
    bar.innerHTML = notes.join('<span style="flex:1"></span>');
    bar.hidden = !notes.length;
  }

  // ---------------------------------------------------------------- screens
  function card(href, img, label, sub) {
    return '<a class="card" href="' + href + '" data-tap="1"><div class="pic">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') + '</div>' +
      '<div class="label">' + esc(label) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div></a>';
  }
  function grid(cards) {
    return '<div class="grid">' + cards.join('') + '</div>';
  }
  function prompt(key) {
    const p = (C.app && C.app.prompts && C.app.prompts[key]) || {};
    return p;
  }
  function ask(key, fallback) {
    const p = prompt(key);
    return '<div class="ask"><h1>' + esc(p.text || fallback) + '</h1>' + speakBtn(p.audio) + '</div>';
  }

  function showNav(html) {
    const nav = $('#stepNav');
    nav.innerHTML = html || '';
    nav.hidden = !html;
    $('#main').classList.toggle('has-nav', !!html);
  }

  function renderHome() {
    renderTop();
    showNav('');
    const ops = (C.operations || []).filter(o => modelsFor(o).length && (C.steps || {})[o.id]);
    $('#main').innerHTML = ask('operation', 'هتعمل إيه؟') +
      (ops.length ? grid(ops.map(o => card(opLink(o), o.image, o.title))) : '<div class="empty">لسه مفيش شغلانات</div>');
    autoSpeak(prompt('operation').audio);
  }
  /** A job with one model goes straight to its steps. */
  function opLink(o) {
    const ms = modelsFor(o);
    return ms.length === 1 ? link(o.id, ms[0].id, 1) : link(o.id);
  }

  function renderModels(r) {
    const o = opById(r.op);
    if (!o) return replace('#/');
    const ms = modelsFor(o).filter(m => stepsFor(o.id, m.id).length);
    if (ms.length === 1) return replace(link(o.id, ms[0].id, 1));
    renderTop(o.title);
    showNav('<a class="nav-btn" href="#/" data-tap="1">' + I.prev + 'رجوع</a>');
    $('#main').innerHTML = ask('model', 'أنهي جهاز؟') + grid(ms.map(m => card(link(o.id, m.id, 1), m.image, m.title)));
    autoSpeak(prompt('model').audio);
  }

  function renderStep(r) {
    const o = opById(r.op), m = modelById(r.model);
    if (!o || !m) return replace('#/');
    const steps = stepsFor(o.id, m.id);
    if (!steps.length) return replace('#/');
    if (r.n > steps.length) return replace(link(o.id, m.id, steps.length));
    const s = steps[r.n - 1];
    const total = steps.length, n = r.n;
    renderTop(o.title, m.title);

    const media = s.video
      ? '<video src="' + esc(s.video) + '"' + (s.image ? ' poster="' + esc(s.image) + '"' : '') + ' muted playsinline preload="auto"' + (s.audio ? ' loop' : '') + ' data-act="video"></video>' +
        (s.audio ? '' : '<button class="unmute" data-act="unmute" aria-label="شغّل الصوت" hidden>' + I.speaker + '</button>')
      : s.image ? '<img src="' + esc(s.image) + '" alt="" data-act="zoom"><span class="zoom-hint" aria-hidden="true">' + I.zoom + '</span>' : '';
    $('#main').innerHTML =
      '<div class="step-head"><div class="step-no">' + num(n) + '</div><div class="step-of"><div class="of">خطوة ' + num(n) + ' من ' + num(total) + '</div>' +
      '<div class="dots">' + steps.map((x, i) => '<i class="' + (i + 1 === n ? 'now' : i + 1 < n ? 'on' : '') + '"></i>').join('') + '</div></div></div>' +
      (media ? '<div class="media">' + media + '</div>' : '') +
      '<div class="say' + (s.warning ? ' warn' : '') + '">' + (s.warning ? '<span class="warn-ico">' + I.warn + '</span>' : '') +
      '<p>' + esc(s.text) + '</p>' + speakBtn(s.audio) + '</div>' +
      '<div id="savedBadge"></div>';

    const last = n === total;
    const back = n > 1 ? link(o.id, m.id, n - 1) : (modelsFor(o).length > 1 ? link(o.id) : '#/');
    showNav('<a class="nav-btn" href="' + back + '" data-tap="1">' + I.prev + 'رجوع</a>' +
      (last ? '<a class="nav-btn next finish" href="' + link(o.id, m.id, 'done') + '" data-tap="1">' + I.check + 'خلصت</a>'
        : '<a class="nav-btn next" href="' + link(o.id, m.id, n + 1) + '" data-tap="1">التالي' + I.next + '</a>'));

    const tapped = userTap;
    autoSpeak(s.audio);
    if (s.video) startVideo(!s.audio && tapped);
    saveGuide(steps);
  }

  /**
   * Step video. With the step's own recorded voice it stays a silent loop (no two sounds at once).
   * Without one, it plays once with its sound; if the phone only allows silent play, a speaker
   * button on the video turns the sound on.
   */
  function startVideo(withSound) {
    const v = document.querySelector('.media video');
    if (!v) return;
    const unmute = document.querySelector('.media .unmute');
    const silent = () => { v.muted = true; v.play().catch(() => {}); if (unmute) unmute.hidden = false; };
    if (!withSound) { silent(); return; }
    v.muted = false;
    v.play().then(() => { if (unmute) unmute.hidden = true; }, silent);
  }

  /** Saves the whole guide (this job + model) on the phone and shows its state under the step. */
  let savingKey = '';
  async function saveGuide(steps) {
    const urls = Array.from(new Set([].concat(...steps.map(mediaOf)).map(abs)));
    const key = location.hash.split('/').slice(0, 3).join('/');
    const badge = (cls, ico, text) => {
      const el = $('#savedBadge');
      if (el) el.innerHTML = '<span class="saved ' + cls + '">' + ico + esc(text) + '</span>';
    };
    if (!urls.length || !window.caches) return;
    if (await isCached(urls)) { badge('ok', I.check, 'الدليل ده متحفظ على الموبايل'); return; }
    if (savingKey === key) { badge('busy', I.saved, 'بيتحفظ…'); return; }
    savingKey = key;
    const ok = await cacheUrls(urls, (d, t) => { if (savingKey === key) badge('busy', I.saved, 'بيتحفظ ' + num(d) + ' من ' + num(t)); });
    savingKey = '';
    if (location.hash.split('/').slice(0, 3).join('/') !== key) return;
    if (ok) badge('ok', I.check, 'الدليل ده متحفظ على الموبايل');
    else badge('bad', I.offline, 'مش متحفظ كله · افتحه تاني وفيه نت');
  }

  function renderDone(r, problem) {
    const o = opById(r.op), m = modelById(r.model);
    if (!o || !m) return replace('#/');
    renderTop(o.title, m.title);
    showNav('');
    const p = prompt('done');
    $('#main').innerHTML = problem
      ? '<div class="done"><div class="big-ok" style="background:var(--warn-soft);color:var(--warn)">' + I.cross + '</div><h1>كلّم المكتب</h1>' +
        '<a class="wide-btn plain" href="' + link(o.id, m.id, 1) + '" data-tap="1">' + I.restart + 'ابدأ من الأول</a>' +
        '<a class="wide-btn plain" href="#/" data-tap="1">' + I.home + 'الرئيسية</a></div>'
      : '<div class="done"><div class="big-ok">' + I.check + '</div><div class="ask" style="justify-content:center"><h1>' + esc(p.text || 'خلصت! الجهاز اشتغل؟') + '</h1>' + speakBtn(p.audio) + '</div>' +
        '<div class="answers"><a class="answer yes" href="#/" data-tap="1">' + I.check + 'أيوه</a>' +
        '<button class="answer no" data-act="problem">' + I.cross + 'لأ</button></div></div>';
    if (!problem) autoSpeak(p.audio);
  }

  function autoSpeak(src) {
    if (userTap && src) playSound(src, document.querySelector('.speak[data-src="' + CSS.escape(src) + '"]'));
    userTap = false;
  }

  let reloadWhenFree = false;
  /** Reloads for a new site version only on the jobs or models screen, never in the middle of a guide. */
  function reloadIfFree() {
    if (!reloadWhenFree) return false;
    const p = route().page;
    if (p !== 'home' && p !== 'models') return false;
    reloadWhenFree = false;
    location.reload();
    return true;
  }

  function render() {
    if (reloadIfFree()) return;
    stopSound();
    closeZoom();
    renderNote();
    const r = route();
    if (r.page === 'home') { if (pending) { applyPending(); return; } renderHome(); }
    else if (r.page === 'models') renderModels(r);
    else if (r.page === 'step') renderStep(r);
    else renderDone(r);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- full-screen picture
  function openZoom(src) {
    const z = $('#zoom');
    z.innerHTML = '<img src="' + esc(src) + '" alt=""><button class="round" data-act="unzoom" aria-label="اقفل">' + I.cross + '</button>';
    z.hidden = false;
  }
  function closeZoom() { const z = $('#zoom'); z.hidden = true; z.innerHTML = ''; }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', ev => {
    const a = ev.target.closest('a[data-tap]');
    if (a) { userTap = true; return; }   // normal link; the hash change renders the next screen
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'home') { go('#/'); return; }
    if (act === 'speak') { if (playingBtn === el) stopSound(); else playSound(el.dataset.src, el); return; }
    if (act === 'zoom') { openZoom(el.getAttribute('src')); return; }
    if (act === 'unzoom') { closeZoom(); return; }
    if (act === 'video') {
      const unmute = document.querySelector('.media .unmute');
      if (unmute && el.muted) { el.muted = false; unmute.hidden = true; el.currentTime = 0; el.play().catch(() => {}); return; }
      if (el.ended) { el.currentTime = 0; el.play().catch(() => {}); return; }
      if (el.paused) el.play().catch(() => {}); else el.pause();
      return;
    }
    if (act === 'unmute') {
      const v = document.querySelector('.media video');
      if (v) { v.muted = false; v.currentTime = 0; v.play().catch(() => {}); }
      el.hidden = true;
      return;
    }
    if (act === 'problem') { renderDone(route(), true); return; }
    if (act === 'retry') { start(); }
  });
  $('#zoom').addEventListener('click', ev => { if (ev.target.id === 'zoom' || ev.target.tagName === 'IMG') closeZoom(); });
  document.addEventListener('keydown', ev => {    // for testing on a computer
    if (ev.key === 'Escape') { closeZoom(); return; }
    const nav = $('#stepNav');
    if (nav.hidden) return;
    const btns = nav.querySelectorAll('a');
    if (ev.key === 'ArrowLeft' && btns[1]) { userTap = true; btns[1].click(); }
    if (ev.key === 'ArrowRight' && btns[0]) { userTap = true; btns[0].click(); }
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { renderNote(); checkForUpdate(); });
  window.addEventListener('offline', renderNote);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

  // ---------------------------------------------------------------- start
  async function start() {
    if (await loadContent()) { render(); return; }
    $('#top').innerHTML = '<div class="brand"><img src="assets/icons/mark-96.png" alt=""><div><div class="t">دليل الفني</div></div></div>';
    $('#main').innerHTML = '<div class="empty">' + I.offline.replace('<svg', '<svg style="width:64px;height:64px;margin:0 auto 12px"') +
      'محتاج نت أول مرة بس<br><button class="wide-btn plain" data-act="retry" style="margin-top:20px">' + I.restart + 'جرّب تاني</button></div>';
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* still works online */ });
    // A newer version of the site arrived: reload on the jobs or models screen, not in a guide.
    navigator.serviceWorker.addEventListener('message', e => {
      if (!e.data || e.data.type !== 'updated') return;
      reloadWhenFree = true;
      reloadIfFree();
    });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  start();
})();
