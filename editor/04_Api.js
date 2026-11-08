/**
 * Web app entry point and the API the page calls through google.script.run.
 * Every sstm-eg.com account can use it (the deployment is open to the domain only), and every change
 * returns the whole (small) dataset so the page always shows what the sheet holds.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('SSTM · ' + APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(file) {
  return HtmlService.createHtmlOutputFromFile(file).getContent();
}

// ---------- access ----------

function currentUser_() {
  return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

/** Any signed-in sstm-eg.com account. Google already limits the web app to the domain; this also
 *  covers the page's server functions. */
function requireStaff_() {
  const user = currentUser_();
  if (!/@sstm-eg\.com$/.test(user)) throw new Error('Sign in with your sstm-eg.com account.');
  return user;
}

// ---------- reading ----------

function payload_() {
  const s = settings_();
  const editable = {};
  SETTINGS.forEach(d => { if (INTERNAL_SETTINGS.indexOf(d[0]) === -1) editable[d[0]] = s[d[0]]; });
  const folderId = PropertiesService.getScriptProperties().getProperty('MEDIA_FOLDER_ID');
  return {
    jobs: readTable_('Jobs'),
    models: readTable_('Models'),
    steps: readTable_('Steps'),
    media: readTable_('Media').map(r => ({ name: r.Name, type: r.Type, bytes: Number(r.Bytes) || 0, published: r.Published === 'Yes', drive: !!r['Drive ID'] })),
    settings: editable,
    settingsInfo: SETTINGS.filter(d => INTERNAL_SETTINGS.indexOf(d[0]) === -1).map(d => ({ key: d[0], description: d[2] })),
    lastEdit: s.last_edit, lastPublish: s.last_publish, lastCommit: s.last_commit,
    hasToken: !!token_(),
    user: currentUser_(),
    site: SITE_URL, repo: REPO,
    sheetUrl: ss_().getUrl(),
    folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + folderId : '',
  };
}

function apiLoad() {
  requireStaff_();
  seedFromSite_();
  return payload_();
}

/** The bytes of one media file (for previews of files not on the site yet). */
function apiMediaData(name) {
  requireStaff_();
  const blob = mediaBlob_(String(name));
  if (!blob) throw new Error('File ' + name + ' is missing or empty in the Drive folder. Upload it again.');
  return { name: name, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ---------- changes ----------

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const byOrder_ = (a, b) => Number(a.Order) - Number(b.Order);
const splitIds_ = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);

/** Adds a job ({ID, Title}), a model ({ID, Title}) or a step ({Job, after}). */
function apiCreate(table, rec) {
  requireStaff_();
  rec = rec || {};
  return withLock_(() => {
    if (table === 'Jobs' || table === 'Models') {
      const id = String(rec.ID || '').trim().toLowerCase();
      const title = String(rec.Title || '').trim();
      if (!ID_RE.test(id)) throw new Error('The link name must be small English letters, numbers and dashes, e.g. replace-sensor.');
      if (!title) throw new Error('Write the Arabic name.');
      const rows = readTable_(table);
      if (rows.some(r => r.ID === id)) throw new Error('"' + id + '" already exists.');
      const order = rows.reduce((m, r) => Math.max(m, Number(r.Order) || 0), 0) + 1;
      const row = table === 'Jobs'
        ? { ID: id, Title: title, Picture: '', Sound: '', Models: readTable_('Models').sort(byOrder_).map(m => m.ID).join(', '), Order: order, Show: 'Yes' }
        : { ID: id, Title: title, Picture: '', Sound: '', Order: order };
      rows.push(row);
      writeTable_(table, rows);
      log_('Created', table.slice(0, -1) + ' ' + id, title);
    } else if (table === 'Steps') {
      const job = String(rec.Job || '');
      if (!readTable_('Jobs').some(j => j.ID === job)) throw new Error('This job no longer exists.');
      const rows = readTable_('Steps');
      const mine = rows.filter(s => s.Job === job).sort(byOrder_);
      const after = rec.after ? mine.findIndex(s => s.ID === rec.after) : -1;
      if (rec.after && after === -1) throw new Error('That step was deleted. Reload the page.');
      const at = rec.after ? after + 1 : mine.length;
      const step = { ID: newStepId_(), Job: job, Models: '', Warning: 'No', Text: '', Picture: '', Video: '', Sound: '' };
      mine.splice(at, 0, step);
      mine.forEach((s, i) => { s.Order = i + 1; });
      writeTable_('Steps', rows.filter(s => s.Job !== job).concat(mine));
      log_('Created', 'Step in ' + job, 'Step ' + (at + 1));
    } else {
      throw new Error('Unknown table: ' + table);
    }
    touch_();
    return payload_();
  });
}

/** Changes text / list / yes-no fields of one row. */
function apiSet(table, id, fields) {
  requireStaff_();
  if (!EDITABLE[table]) throw new Error('Unknown table: ' + table);
  return withLock_(() => {
    const rows = readTable_(table);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error('This item no longer exists. Reload the page.');
    const modelIds = readTable_('Models').map(m => m.ID);
    const changes = [];
    Object.keys(fields || {}).forEach(k => {
      if (EDITABLE[table].indexOf(k) === -1) throw new Error(k + ' cannot be changed here.');
      let v = String(fields[k] === null || fields[k] === undefined ? '' : fields[k]).trim();
      if (k === 'Models') v = splitIds_(v).filter(m => modelIds.indexOf(m) !== -1).join(', ');
      if (k === 'Show' || k === 'Warning') v = /^y/i.test(v) ? 'Yes' : 'No';
      if (k === 'Title' && !v) throw new Error('The name cannot be empty.');
      if (row[k] !== v) { changes.push(k + ': ' + (row[k] || '—') + ' → ' + (v || '—')); row[k] = v; }
    });
    if (changes.length) {
      writeTable_(table, rows);
      touch_();
      log_('Updated', table.slice(0, -1) + ' ' + (table === 'Steps' ? row.Job + ' #' + row.Order : id), changes.join('; '));
    }
    return payload_();
  });
}

/**
 * Uploads in pieces (see 02_Media.js): apiUploadStart, then apiUploadChunk for each piece, then
 * apiAttach with the returned name.
 */
function apiUploadStart(info) {
  requireStaff_();
  return uploadStart_(info || {});
}

function apiUploadChunk(id, offset, data) {
  requireStaff_();
  return uploadChunk_(String(id), offset, data);
}

/**
 * Puts an uploaded file into a media field: (Jobs|Models|Steps, id, field) or (Settings, key).
 * upload = {name} of a file already uploaded; null clears the field.
 */
function apiAttach(table, id, field, upload) {
  requireStaff_();
  let kind;
  if (table === 'Settings') {
    if (!/_sound$/.test(id) || !SETTINGS.some(s => s[0] === id)) throw new Error('Unknown setting: ' + id);
    kind = 'audio';
  } else {
    kind = MEDIA_FIELDS[table] && MEDIA_FIELDS[table][field];
    if (!kind) throw new Error(field + ' does not take a file.');
  }
  return withLock_(() => {
    let name = '';
    if (upload) {
      name = String(upload.name || '');
      const m = readTable_('Media').find(r => r.Name === name);
      if (!m || !goodDriveFile_(m['Drive ID'])) throw new Error('The upload did not finish. Try again.');
      if (m.Type !== kind) throw new Error('This place takes a ' + kind + ', not a ' + m.Type + '.');
    }
    if (table === 'Settings') {
      setSettings_({ [id]: name });
    } else {
      const rows = readTable_(table);
      const row = rows.find(r => r.ID === id);
      if (!row) throw new Error('This item no longer exists. Reload the page.');
      row[field] = name;
      writeTable_(table, rows);
    }
    touch_();
    log_(name ? 'Attached' : 'Removed', table + ' ' + id + ' · ' + (field || 'sound'), name || '');
    return payload_();
  });
}

/** Moves a job, model or step one place up (dir -1) or down (dir 1). Steps move within their job. */
function apiMove(table, id, dir) {
  requireStaff_();
  if (['Jobs', 'Models', 'Steps'].indexOf(table) === -1) throw new Error('Unknown table: ' + table);
  return withLock_(() => {
    const rows = readTable_(table);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error('This item no longer exists. Reload the page.');
    const group = rows.filter(r => table !== 'Steps' || r.Job === row.Job).sort(byOrder_);
    const i = group.indexOf(row), j = i + (Number(dir) < 0 ? -1 : 1);
    if (j < 0 || j >= group.length) return payload_();
    group.splice(j, 0, group.splice(i, 1)[0]);
    group.forEach((r, k) => { r.Order = k + 1; });
    writeTable_(table, rows);
    touch_();
    return payload_();
  });
}

function apiDuplicateStep(id) {
  requireStaff_();
  return withLock_(() => {
    const rows = readTable_('Steps');
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error('This step no longer exists. Reload the page.');
    const mine = rows.filter(s => s.Job === row.Job).sort(byOrder_);
    const copy = Object.assign({}, row, { ID: newStepId_() });
    mine.splice(mine.indexOf(row) + 1, 0, copy);
    mine.forEach((s, i) => { s.Order = i + 1; });
    writeTable_('Steps', rows.filter(s => s.Job !== row.Job).concat(mine));
    touch_();
    log_('Created', 'Step in ' + row.Job, 'Copy of step ' + row.Order);
    return payload_();
  });
}

/**
 * Deletes a job (and its steps), a model (taken off every job and step; steps only for that model
 * are deleted) or a step.
 */
function apiDelete(table, id) {
  requireStaff_();
  if (['Jobs', 'Models', 'Steps'].indexOf(table) === -1) throw new Error('Unknown table: ' + table);
  return withLock_(() => {
    const rows = readTable_(table);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error('This item no longer exists. Reload the page.');
    writeTable_(table, rows.filter(r => r !== row));
    let detail = row.Title || row.Text || '';
    if (table === 'Jobs') {
      const steps = readTable_('Steps');
      const left = steps.filter(s => s.Job !== id);
      writeTable_('Steps', left);
      detail += ' · ' + (steps.length - left.length) + ' steps deleted';
    } else if (table === 'Models') {
      const jobs = readTable_('Jobs');
      jobs.forEach(j => { j.Models = splitIds_(j.Models).filter(m => m !== id).join(', '); });
      writeTable_('Jobs', jobs);
      const steps = readTable_('Steps');
      const onlyThis = s => { const ms = splitIds_(s.Models); return ms.length && ms.every(m => m === id); };
      const left = steps.filter(s => !onlyThis(s));
      left.forEach(s => { s.Models = splitIds_(s.Models).filter(m => m !== id).join(', '); });
      writeTable_('Steps', left);
      detail += ' · ' + (steps.length - left.length) + ' steps deleted';
    } else if (table === 'Steps') {
      const steps = readTable_('Steps');
      steps.filter(s => s.Job === row.Job).sort(byOrder_).forEach((s, i) => { s.Order = i + 1; });
      writeTable_('Steps', steps);
    } else {
      throw new Error('Unknown table: ' + table);
    }
    touch_();
    log_('Deleted', table.slice(0, -1) + ' ' + (table === 'Steps' ? row.Job + ' #' + row.Order : id), detail);
    return payload_();
  });
}

function apiSetSettings(values) {
  requireStaff_();
  return withLock_(() => {
    const clean = {};
    Object.keys(values || {}).forEach(k => {
      const def = SETTINGS.find(s => s[0] === k);
      if (!def || INTERNAL_SETTINGS.indexOf(k) !== -1 || /_sound$/.test(k)) return;
      clean[k] = String(values[k] === null || values[k] === undefined ? '' : values[k]).trim();
    });
    const before = settings_();
    setSettings_(clean);
    const changed = Object.keys(clean).filter(k => before[k] !== clean[k]);
    if (changed.length) {
      touch_();
      log_('Updated', 'Settings', changed.map(k => k + ': ' + (before[k] || '—') + ' → ' + (clean[k] || '—')).join('; '));
    }
    return payload_();
  });
}

/** Saves the GitHub token after checking it can write to the repo. Empty removes it. */
function apiSetToken(token) {
  requireStaff_();
  token = String(token || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!token) {
    props.deleteProperty('GITHUB_TOKEN');
    log_('Updated', 'GitHub token', 'Removed');
    return payload_();
  }
  checkToken_(token);
  props.setProperty('GITHUB_TOKEN', token);
  log_('Updated', 'GitHub token', 'Set (…' + token.slice(-4) + ')');
  return payload_();
}

function apiPublish() {
  requireStaff_();
  const result = publish_();   // takes the lock only for its short sheet reads and writes
  return { result: result, data: payload_() };
}
