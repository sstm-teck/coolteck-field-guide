/**
 * Pictures, videos and sounds. Each upload is saved once in the Drive folder under a name made from
 * its content (e.g. 3f9a1c2b7d4e5a60.webp), so the same file is never stored twice and a changed
 * file always gets a new name (the phones then download the new one instead of keeping an old copy).
 */

function mediaFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MEDIA_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* deleted: make a new one */ }
  }
  const parents = DriveApp.getFileById(ss_().getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const found = parent.getFoldersByName(MEDIA_FOLDER_NAME);
  const folder = found.hasNext() ? found.next() : parent.createFolder(MEDIA_FOLDER_NAME);
  props.setProperty('MEDIA_FOLDER_ID', folder.getId());
  return folder;
}

function kindOfMime_(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return m.split('/')[0];
}

function kindOfName_(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['webp', 'jpg', 'jpeg', 'png', 'svg', 'gif'].indexOf(ext) !== -1) return 'image';
  if (['mp4', 'webm', 'mov'].indexOf(ext) !== -1) return 'video';
  return 'audio';
}

// ---------- uploads ----------
// DriveApp.createFile saved some uploads as EMPTY files (seen with recorded WebM sounds), so files go
// to Drive through its REST "resumable upload": the page sends the file in pieces (UPLOAD_CHUNK bytes,
// which also drives its progress bar), each piece is passed on to the upload session, and Drive's
// reported size is checked at the end. The page names the file by its SHA-256 (first 16 hex digits).

const UPLOAD_CHUNK = 1024 * 1024;   // must be a multiple of 256 KB (Drive rule); App.html uses the same
const UPLOAD_SECONDS = 6 * 3600;

function driveToken_() {
  return ScriptApp.getOAuthToken();
}

/** A Drive file that really has content (an empty one from the old upload doesn't count). */
function goodDriveFile_(id) {
  if (!id) return null;
  try {
    const f = DriveApp.getFileById(id);
    return !f.isTrashed() && f.getSize() > 0 ? f : null;
  } catch (e) {
    return null;
  }
}

/**
 * Starts an upload. info = {hash, mime, size, kind, name}. Returns {done: true, name} when the same
 * file is already saved, otherwise {done: false, id, name, chunk} for uploadChunk_.
 */
function uploadStart_(info) {
  const mime = String(info.mime || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[mime];
  const kind = String(info.kind || '');
  const size = Number(info.size) || 0;
  if (!ext) throw new Error('This file type is not supported (' + (mime || 'unknown') + '). Use a photo, an MP4 video or an MP3 / M4A / WebM sound.');
  if (kindOfMime_(mime) !== kind) throw new Error('This place takes a ' + kind + ', not a ' + kindOfMime_(mime) + '.');
  if (!/^[0-9a-f]{16}$/.test(String(info.hash))) throw new Error('Bad file fingerprint. Reload the page and try again.');
  if (size <= 0) throw new Error('The file is empty.');
  if (size > MEDIA_MAX_BYTES[kind]) throw new Error('The file is too big (' + mb_(size) + '). The limit for a ' + kind + ' is ' + mb_(MEDIA_MAX_BYTES[kind]) + '.');
  const name = info.hash + '.' + ext;

  const row = readTable_('Media').find(r => r.Name === name);
  if (row && goodDriveFile_(row['Drive ID'])) return { done: true, name: name };

  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + driveToken_(), 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
    payload: JSON.stringify({ name: name, parents: [mediaFolder_().getId()], mimeType: mime, description: 'CoolTeck Field Guide media · uploaded as ' + String(info.name || 'file').slice(0, 100) }),
  });
  const uri = res.getHeaders().Location || res.getHeaders().location;
  if (res.getResponseCode() !== 200 || !uri) throw new Error('Drive did not accept the upload (' + res.getResponseCode() + '). Try again.');
  const id = Utilities.getUuid();
  CacheService.getScriptCache().put('up:' + id, JSON.stringify({ uri: uri, name: name, mime: mime, size: size, kind: kind, user: currentUser_() }), UPLOAD_SECONDS);
  return { done: false, id: id, name: name, chunk: UPLOAD_CHUNK };
}

/** Sends one piece (base64) at byte offset. Returns {done, name}; the last piece records the file. */
function uploadChunk_(id, offset, data) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get('up:' + id);
  if (!raw) throw new Error('The upload expired. Try again.');
  const up = JSON.parse(raw);
  const bytes = Utilities.base64Decode(String(data || ''));
  offset = Number(offset) || 0;
  if (!bytes.length) throw new Error('Empty piece of the file. Try again.');
  const end = offset + bytes.length - 1;
  const res = UrlFetchApp.fetch(up.uri, {
    method: 'put', contentType: up.mime, payload: bytes, muteHttpExceptions: true,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + up.size },
  });
  const code = res.getResponseCode();
  if (code === 308) return { done: false, name: up.name };
  if (code !== 200 && code !== 201) throw new Error('Drive stopped the upload (' + code + '). Try again.');
  const file = JSON.parse(res.getContentText());
  if (Number(file.size) !== up.size) {
    try { DriveApp.getFileById(file.id).setTrashed(true); } catch (e) { /* best effort */ }
    throw new Error('The file arrived incomplete (' + (file.size || 0) + ' of ' + up.size + ' bytes). Try again.');
  }
  withLock_(() => {
    const rows = readTable_('Media');
    const row = rows.find(r => r.Name === up.name);
    if (row && row['Drive ID'] && row['Drive ID'] !== file.id) {
      try { DriveApp.getFileById(row['Drive ID']).setTrashed(true); } catch (e) { /* old empty copy */ }
    }
    const rec = { Name: up.name, Type: up.kind, Bytes: up.size, 'Drive ID': file.id, Published: row ? row.Published : 'No', 'Uploaded by': up.user, Time: new Date() };
    if (row) { Object.assign(row, rec); writeTable_('Media', rows); } else appendRow_('Media', rec);
  });
  cache.remove('up:' + id);
  return { done: true, name: up.name };
}

function mb_(n) {
  return (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';
}

/** The file's bytes from Drive, or null when it only exists on the site or the Drive copy is empty. */
function mediaBlob_(name, rows) {
  const row = (rows || readTable_('Media')).find(r => r.Name === name);
  const f = row && goodDriveFile_(row['Drive ID']);
  return f ? f.getBlob() : null;
}
