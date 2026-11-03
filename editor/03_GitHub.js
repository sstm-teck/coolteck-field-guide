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
    if (code === 403 || code === 404) throw new Error('The token has no write access to ' + REPO + ' (' + msg + '). It needs Contents: Read and write on this repository.');
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
  const jobs = readTable_('Jobs').filter(j => j.Show !== 'No').sort(byOrder);
  const steps = readTable_('Steps');
  const out = {
    version: Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd.HHmmss'),
    sample: /^y/i.test(s.sample),
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

function publish_() {
  if (!token_()) throw new Error('Set the GitHub token on the Settings page first.');
  const content = buildContent_();
  const used = usedMedia_(content);

  const head = gh_('get', '/git/ref/heads/' + BRANCH).object.sha;
  const baseTree = gh_('get', '/git/commits/' + head).tree.sha;
  const tree = gh_('get', '/git/trees/' + baseTree + '?recursive=1');
  if (tree.truncated) throw new Error('The repository is too big to read in one go.');
  const inRepo = {};
  tree.tree.forEach(t => { if (t.type === 'blob') inRepo[t.path] = t.sha; });

  const mediaRows = readTable_('Media');
  const entries = [];
  const added = [], missing = [];
  used.forEach(n => {
    if (inRepo[MEDIA_DIR + n]) return;
    const blob = mediaBlob_(n, mediaRows);
    if (!blob) { missing.push(n); return; }
    const b = gh_('post', '/git/blobs', { content: Utilities.base64Encode(blob.getBytes()), encoding: 'base64' });
    entries.push({ path: MEDIA_DIR + n, mode: '100644', type: 'blob', sha: b.sha });
    added.push(n);
  });
  if (missing.length) throw new Error('These files are missing from the Drive folder and the site: ' + missing.join(', ') + '. Upload them again.');

  const removed = Object.keys(inRepo).filter(p => p.indexOf(MEDIA_DIR) === 0 && used.indexOf(p.slice(MEDIA_DIR.length)) === -1);
  removed.forEach(p => entries.push({ path: p, mode: '100644', type: 'blob', sha: null }));

  const json = JSON.stringify(content, null, 1) + '\n';
  const cb = gh_('post', '/git/blobs', { content: json, encoding: 'utf-8' });
  entries.push({ path: CONTENT_PATH, mode: '100644', type: 'blob', sha: cb.sha });

  const user = currentUser_();
  const steps = Object.keys(content.steps).reduce((n, k) => n + content.steps[k].length, 0);
  const message = 'Publish guide content ' + content.version + '\n\n' +
    content.operations.length + ' jobs, ' + content.models.length + ' models, ' + steps + ' steps; ' +
    added.length + ' new media file(s), ' + removed.length + ' removed.\nPublished from the Field Guide Editor by ' + user + '.';
  const newTree = gh_('post', '/git/trees', { base_tree: baseTree, tree: entries });
  const commit = gh_('post', '/git/commits', { message: message, tree: newTree.sha, parents: [head] });
  gh_('patch', '/git/refs/heads/' + BRANCH, { sha: commit.sha });

  const usedSet = {};
  used.forEach(n => { usedSet[n] = true; });
  mediaRows.forEach(r => { r.Published = usedSet[r.Name] ? 'Yes' : 'No'; });
  writeTable_('Media', mediaRows);
  setSettings_({ last_publish: new Date().toISOString(), last_commit: commit.sha });
  log_('Published', content.version, message.split('\n\n')[1].split('\n')[0] + ' · commit ' + commit.sha.slice(0, 7));
  return {
    version: content.version, commit: commit.sha, commitUrl: 'https://github.com/' + REPO + '/commit/' + commit.sha,
    jobs: content.operations.length, steps: steps, added: added.length, removed: removed.length,
  };
}
