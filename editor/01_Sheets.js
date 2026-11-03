/**
 * The bound Google Sheet as the editor's database: one table per sheet, headers in row 1.
 * The content is small (tens of jobs, hundreds of steps), so a change reads its table, edits it in
 * memory and writes it back in one call. Sheets are created and formatted when first needed, and
 * the first time the app runs it imports the content already on the public site.
 */

const MEMO_ = { ss: null, sheets: {} };

function ss_() {
  if (MEMO_.ss) return MEMO_.ss;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  MEMO_.ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!MEMO_.ss) throw new Error('The editor is not linked to its Google Sheet.');
  return MEMO_.ss;
}

function cell_(v) {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? '' : String(v).trim();
}

function sheet_(name) {
  if (MEMO_.sheets[name]) return MEMO_.sheets[name];
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    const def = TABLES[name];
    sh = ss.insertSheet(name, Math.min(SHEET_ORDER.indexOf(name), ss.getSheets().length));
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    formatTable_(sh, def);
    if (name === 'Settings') sh.getRange(2, 1, SETTINGS.length, 3).setValues(SETTINGS);
    const blank = ss.getSheetByName('Sheet1');
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  }
  return (MEMO_.sheets[name] = sh);
}

/** Rows as objects keyed by header (header names, not positions, so moved columns still work). */
function readTable_(name) {
  const def = TABLES[name];
  const values = sheet_(name).getDataRange().getValues();
  if (!values.length) return [];
  const idx = {};
  values[0].forEach((h, i) => { if (cell_(h)) idx[cell_(h)] = i; });
  const first = idx[def.headers[0]] === undefined ? 0 : idx[def.headers[0]];
  return values.slice(1).filter(r => cell_(r[first]) !== '').map(r => {
    const o = {};
    def.headers.forEach(h => { o[h] = idx[h] === undefined ? '' : cell_(r[idx[h]]); });
    return o;
  });
}

/** Replaces every data row of a table. */
function writeTable_(name, rows) {
  const def = TABLES[name];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, def.headers.length).clearContent();
  if (!rows.length) return;
  if (rows.length + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows() + 200);
  sh.getRange(2, 1, rows.length, def.headers.length).setValues(rows.map(r => def.headers.map(h => (r[h] === undefined ? '' : r[h]))));
}

function appendRow_(name, row) {
  const def = TABLES[name];
  sheet_(name).appendRow(def.headers.map(h => (row[h] === undefined ? '' : row[h])));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- settings ----------

function settings_() {
  const out = {};
  SETTINGS.forEach(s => { out[s[0]] = s[1]; });
  readTable_('Settings').forEach(r => { out[r.Key] = r.Value; });
  return out;
}

/** Writes some settings, adding any key the sheet doesn't have yet. */
function setSettings_(values) {
  const rows = readTable_('Settings');
  Object.keys(values).forEach(k => {
    const row = rows.find(r => r.Key === k);
    if (row) row.Value = values[k];
    else {
      const def = SETTINGS.find(s => s[0] === k);
      rows.push({ Key: k, Value: values[k], Description: def ? def[2] : '' });
    }
  });
  writeTable_('Settings', rows);
}

function touch_() {
  setSettings_({ last_edit: new Date().toISOString() });
}

// ---------- log ----------

function log_(action, item, details) {
  try {
    appendRow_('Log', { Time: new Date(), User: currentUser_() || 'unknown', Action: action, Item: item, Details: details || '' });
  } catch (e) {
    console.warn('Log failed: ' + e);
  }
}

// ---------- first run ----------

/**
 * Fills empty Jobs / Models / Steps sheets from the content already published on the site, so the
 * editor starts with what the technicians see. Media already in the repo is listed as published.
 */
function seedFromSite_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SEEDED') === '1') return;
  if (readTable_('Jobs').length || readTable_('Models').length || readTable_('Steps').length) {
    props.setProperty('SEEDED', '1');
    return;
  }
  let c;
  try {
    const res = UrlFetchApp.fetch(SITE_URL + CONTENT_PATH + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    c = JSON.parse(res.getContentText());
  } catch (e) {
    return;
  }
  const file = u => String(u || '').replace(/^media\//, '');
  const media = {};
  const note = u => { if (u) media[file(u)] = true; };

  writeTable_('Models', (c.models || []).map((m, i) => {
    note(m.image); note(m.audio);
    return { ID: m.id, Title: m.title, Picture: file(m.image), Sound: file(m.audio), Order: i + 1 };
  }));
  writeTable_('Jobs', (c.operations || []).map((o, i) => {
    note(o.image); note(o.audio);
    return { ID: o.id, Title: o.title, Picture: file(o.image), Sound: file(o.audio), Models: (o.models || []).join(', '), Order: i + 1, Show: 'Yes' };
  }));
  const steps = [];
  Object.keys(c.steps || {}).forEach(job => c.steps[job].forEach((s, i) => {
    note(s.image); note(s.video); note(s.audio);
    steps.push({
      ID: newStepId_(), Job: job, Order: i + 1, Models: (s.models || []).join(', '), Warning: s.warning ? 'Yes' : 'No',
      Text: s.text, Picture: file(s.image), Video: file(s.video), Sound: file(s.audio),
    });
  }));
  writeTable_('Steps', steps);

  const app = c.app || {}, p = app.prompts || {};
  const val = (o, k) => (o && o[k]) || '';
  setSettings_({
    title: app.title || 'دليل الفني', subtitle: app.subtitle || '',
    ask_job: val(p.operation, 'text'), ask_job_sound: file(val(p.operation, 'audio')),
    ask_model: val(p.model, 'text'), ask_model_sound: file(val(p.model, 'audio')),
    ask_done: val(p.done, 'text'), ask_done_sound: file(val(p.done, 'audio')),
    sample: c.sample ? 'Yes' : 'No',
    last_publish: new Date().toISOString(), last_edit: new Date().toISOString(),
  });
  writeTable_('Media', Object.keys(media).map(n => ({
    Name: n, Type: kindOfName_(n), Bytes: '', 'Drive ID': '', Published: 'Yes', 'Uploaded by': 'site', Time: new Date(),
  })));
  props.setProperty('SEEDED', '1');
  log_('Imported', 'Site content', (c.operations || []).length + ' jobs, ' + steps.length + ' steps from ' + SITE_URL);
}

function newStepId_() {
  return 's-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

// ---------- formatting ----------

function formatTable_(sh, def) {
  const cols = def.headers.length;
  const rows = Math.max(sh.getMaxRows(), 200);
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() > cols) sh.deleteColumns(cols + 1, sh.getMaxColumns() - cols);
  sh.getBandings().forEach(b => b.remove());
  const all = sh.getRange(1, 1, rows, cols);
  all.setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle').setWrap(false).setFontColor('#1F2937');
  all.applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false)
    .setHeaderRowColor('#1F3864').setFirstRowColor('#FFFFFF').setSecondRowColor('#F3F6FB');
  sh.getRange(1, 1, 1, cols).setFontColor('#FFFFFF').setFontWeight('bold');
  sh.setRowHeight(1, 34);
  sh.setFrozenRows(1);
  sh.setHiddenGridlines(true);
  def.widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  if (def.tab) sh.setTabColor(def.tab);
  const col = h => def.headers.indexOf(h) + 1;
  if (col('Time')) sh.getRange(2, col('Time'), rows - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  if (col('Text')) sh.getRange(2, col('Text'), rows - 1, 1).setWrap(true).setHorizontalAlignment('right');
  if (col('Title')) sh.getRange(2, col('Title'), rows - 1, 1).setHorizontalAlignment('right');
  if (col('Description')) sh.getRange(2, col('Description'), rows - 1, 1).setWrap(true).setFontColor('#475569');
}

/** Re-applies formatting to every sheet. Run from the Apps Script editor if a sheet looks off. */
function formatSheets() {
  SHEET_ORDER.forEach(n => formatTable_(sheet_(n), TABLES[n]));
}

/** Simple trigger: someone typed in the sheet by hand, so the page should reload to see it. */
function onEdit() {
  try { setSettings_({ last_edit: new Date().toISOString() }); } catch (e) { /* best effort */ }
}
