/**
 * Publishing: content.json plus the media it uses go into the GitHub repo as ONE commit (Git Data
 * API), so the site never shows half an update. Media no longer used is removed from the repo in
 * the same commit (it stays in the Drive folder). GitHub Pages then rebuilds the site.
 */

function token_() {
  return PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') || '';
}

function gh_(method, path, body, token) {
  const opts = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + (token || token_()), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (body !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + path, opts);
  const code = res.getResponseCode();
  let data = null;
  try { data = JSON.parse(res.getContentText() || 'null'); } catch (e) { data = res.getContentText(); }
  if (code >= 400) {
    const msg = data && data.message ? data.message : String(data).slice(0, 200);
    if (code === 401) throw new Error('GitHub refused the token (' + msg + '). Set a new token on the Settings page.');
    if (code === 403 && /rate limit|secondary/i.test(msg)) throw new Error('GitHub asks to slow down (' + msg + '). Wait a few minutes, then press Publish again.');
    if (code === 403 || code === 404) throw new Error('The token has no write access to ' + REPO + ' (' + msg + '). It needs Contents: Read and write on this repository.');
    if (code === 422 && /Update is not a fast forward|fast forward/i.test(msg)) throw new Error('The site changed while publishing. Press Publish again.');
    throw new Error('GitHub: ' + msg + ' (' + code + ')');
  }
  return data;
}

/** Checks a token can write to the repo before it is saved. */
function checkToken_(token) {
  const repo = gh_('get', '', undefined, token);
  if (!repo.permissions || !repo.permissions.push) throw new Error('This token can read ' + REPO + ' but not write to it. Give it Contents: Read and write.');
  return true;
}

/** The site's content.json, built from the sheets. Media paths point into media/. */
function buildContent_() {
  const s = settings_();
  const path = n => (n ? MEDIA_DIR + n : '');
  const byOrder = (a, b) => Number(a.Order) - Number(b.Order);
  const split = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const models = readTable_('Models').sort(byOrder);
  const modelIds = models.map(m => m.ID);
  const steps = readTable_('Steps');
  const jobs = readTable_('Jobs').filter(j => j.Show !== 'No' && steps.some(x => x.Job === j.ID)).sort(byOrder);
  const out = {
    version: Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd.HHmmss.SSS'),
    app: {
      title: s.title, subtitle: s.subtitle,
      prompts: {
        operation: { text: s.ask_job, audio: path(s.ask_job_sound) },
        model: { text: s.ask_model, audio: path(s.ask_model_sound) },
        done: { text: s.ask_done, audio: path(s.ask_done_sound) },
      },
    },
    operations: jobs.map(j => ({
      id: j.ID, title: j.Title, image: path(j.Picture), audio: path(j.Sound),
      models: split(j.Models).filter(m => modelIds.indexOf(m) !== -1),
    })),
    models: models.map(m => ({ id: m.ID, title: m.Title, image: path(m.Picture), audio: path(m.Sound) })),
    steps: {},
  };
  jobs.forEach(j => {
    out.steps[j.ID] = steps.filter(x => x.Job === j.ID).sort(byOrder).map(x => ({
      id: x.ID, models: split(x.Models), warning: x.Warning === 'Yes', text: x.Text,
      image: path(x.Picture), video: path(x.Video), audio: path(x.Sound),
    }));
  });
  return out;
}

/** Every media file name the content uses. */
function usedMedia_(content) {
  const out = {};
  const add = p => { if (p) out[p.slice(MEDIA_DIR.length)] = true; };
  Object.keys(content.app.prompts).forEach(k => add(content.app.prompts[k].audio));
  content.operations.forEach(o => { add(o.image); add(o.audio); });
  content.models.forEach(m => { add(m.image); add(m.audio); });
  Object.keys(content.steps).forEach(k => content.steps[k].forEach(s => { add(s.image); add(s.video); add(s.audio); }));
  return Object.keys(out);
}

/** Where the given media names are used, for error messages (e.g. "Settings › ask_job_sound"). */
function whereUsed_(names) {
  const out = [];
  const s = settings_();
  Object.keys(s).forEach(k => { if (names.indexOf(s[k]) !== -1) out.push('Settings › ' + k); });
  readTable_('Jobs').forEach(j => ['Picture', 'Sound'].forEach(f => { if (names.indexOf(j[f]) !== -1) out.push('Job ' + j.ID + ' › ' + f); }));
  readTable_('Models').forEach(m => ['Picture', 'Sound'].forEach(f => { if (names.indexOf(m[f]) !== -1) out.push('Model ' + m.ID + ' › ' + f); }));
  readTable_('Steps').forEach(x => ['Picture', 'Video', 'Sound'].forEach(f => { if (names.indexOf(x[f]) !== -1) out.push('Step ' + x.Job + ' #' + x.Order + ' › ' + f); }));
  return out.join(', ') || 'not found';
}

const PUBLISH_BUDGET_MS = 4 * 60 * 1000;   // Apps Script stops a run at 6 minutes

/**
 * One publish at a time (a flag, not the script lock, so editing keeps working meanwhile). Files sent
 * to GitHub are remembered for 6 hours, so a publish stopped by the time limit continues where it
 * stopped. Repo media that cannot be sent again from Drive (e.g. files imported from the site) is
 * never removed.
 */
function publish_() {
  if (!token_()) throw new Error('Set the GitHub token on the Settings page first.');
  const t0 = Date.now();
  const cache = CacheService.getScriptCache();
  withLock_(() => {
    const who = cache.get('publishing');
    if (who) throw new Error(who + ' is publishing right now. Try again in a minute.');
    cache.put('publishing', currentUser_() || 'Someone', 7 * 60);
  });
  try {
    const snap = withLock_(() => ({ content: buildContent_(), rows: readTable_('Media') }));
    const content = snap.content, mediaRows = snap.rows;
    const used = usedMedia_(content);

    const head = gh_('get', '/git/ref/heads/' + BRANCH).object.sha;
    const baseTree = gh_('get', '/git/commits/' + head).tree.sha;
    const tree = gh_('get', '/git/trees/' + baseTree + '?recursive=1');
    if (tree.truncated) throw new Error('The repository is too big to read in one go.');
    const inRepo = {}, filled = {};   // filled = has content; an empty file in the repo is sent again
    tree.tree.forEach(t => { if (t.type === 'blob') { inRepo[t.path] = t.sha; if (t.size > 0) filled[t.path] = true; } });

    const entries = [], added = [], missing = [], waiting = [];
    let sent = 0;
    used.forEach(n => {
      if (filled[MEDIA_DIR + n]) return;
      let sha = cache.get('blob:' + n);
      if (!sha) {
        if (Date.now() - t0 > PUBLISH_BUDGET_MS) { waiting.push(n); return; }
        const blob = mediaBlob_(n, mediaRows);
        if (!blob) { missing.push(n); return; }
        sha = gh_('post', '/git/blobs', { content: Utilities.base64Encode(blob.getBytes()), encoding: 'base64' }).sha;
        cache.put('blob:' + n, sha, 6 * 3600);
        sent++;
      }
      entries.push({ path: MEDIA_DIR + n, mode: '100644', type: 'blob', sha: sha });
      added.push(n);
    });
    if (missing.length) throw new Error('These files are missing or empty: ' + missing.join(', ') + ' (' + whereUsed_(missing) + '). Upload them again, then publish.');
    if (waiting.length) {
      throw new Error('Sent ' + sent + ' file(s) before Google\'s time limit; ' + waiting.length + ' still to go. ' +
        'Press Publish again to continue (files already sent are kept for a few hours).');
    }

    const canResend = n => { const r = mediaRows.find(x => x.Name === n); return !!(r && goodDriveFile_(r['Drive ID'])); };
    const removed = Object.keys(inRepo).filter(p => p.indexOf(MEDIA_DIR) === 0 && used.indexOf(p.slice(MEDIA_DIR.length)) === -1 && canResend(p.slice(MEDIA_DIR.length)));
    removed.forEach(p => entries.push({ path: p, mode: '100644', type: 'blob', sha: null }));

    const json = JSON.stringify(content, null, 1) + '\n';
    const cb = gh_('post', '/git/blobs', { content: json, encoding: 'utf-8' });
    entries.push({ path: CONTENT_PATH, mode: '100644', type: 'blob', sha: cb.sha });

    const user = currentUser_();
    const steps = Object.keys(content.steps).reduce((n, k) => n + content.steps[k].length, 0);
    const message = 'Publish guide content ' + content.version + '\n\n' +
      content.operations.length + ' jobs, ' + content.models.length + ' models, ' + steps + ' steps; ' +
      added.length + ' new media file(s), ' + removed.length + ' removed.\nPublished from the Field Guide Editor by ' + user + '.';
    let newTree;
    try {
      newTree = gh_('post', '/git/trees', { base_tree: baseTree, tree: entries });
    } catch (e) {
      added.forEach(n => cache.remove('blob:' + n));   // a remembered file may be gone from GitHub: send it again next time
      throw e;
    }
    const commit = gh_('post', '/git/commits', { message: message, tree: newTree.sha, parents: [head] });
    gh_('patch', '/git/refs/heads/' + BRANCH, { sha: commit.sha });
    added.forEach(n => cache.remove('blob:' + n));

    // Published = the file is in the repo after this commit.
    const after = {};
    Object.keys(inRepo).forEach(p => { if (p.indexOf(MEDIA_DIR) === 0 && removed.indexOf(p) === -1 && filled[p]) after[p.slice(MEDIA_DIR.length)] = true; });
    added.forEach(n => { after[n] = true; });
    withLock_(() => {
      const rows = readTable_('Media');
      rows.forEach(r => { r.Published = after[r.Name] ? 'Yes' : 'No'; });
      writeTable_('Media', rows);
      setSettings_({ last_publish: new Date().toISOString(), last_commit: commit.sha });
    });
    log_('Published', content.version, message.split('\n\n')[1].split('\n')[0] + ' · commit ' + commit.sha.slice(0, 7));
    return {
      version: content.version, commit: commit.sha, commitUrl: 'https://github.com/' + REPO + '/commit/' + commit.sha,
      jobs: content.operations.length, steps: steps, added: added.length, removed: removed.length,
    };
  } finally {
    cache.remove('publishing');
  }
}
