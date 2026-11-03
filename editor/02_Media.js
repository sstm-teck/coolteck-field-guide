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

/**
 * Saves an upload ({mime, data: base64}) and returns its name. kind ('image' | 'video' | 'audio')
 * is what the field expects; the file has to match it.
 */
function saveMedia_(upload, kind) {
  const mime = String(upload.mime || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[mime];
  if (!ext) throw new Error('This file type is not supported (' + (mime || 'unknown') + '). Use a photo, an MP4 video or an MP3 / M4A / WebM sound.');
  if (kindOfMime_(mime) !== kind) throw new Error('This place takes a ' + kind + ', not a ' + kindOfMime_(mime) + '.');
  const bytes = Utilities.base64Decode(String(upload.data || ''));
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MEDIA_MAX_BYTES[kind]) {
    throw new Error('The file is too big (' + mb_(bytes.length) + '). The limit for a ' + kind + ' is ' + mb_(MEDIA_MAX_BYTES[kind]) + '.');
  }
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .slice(0, 8).map(b => ((b & 0xff) + 0x100).toString(16).slice(1)).join('');
  const name = hash + '.' + ext;

  const rows = readTable_('Media');
  if (rows.some(r => r.Name === name && (r['Drive ID'] || r.Published === 'Yes'))) return name;
  const file = mediaFolder_().createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription('CoolTeck Field Guide media' + (upload.name ? ' · uploaded as ' + upload.name : ''));
  const row = rows.find(r => r.Name === name);
  const rec = { Name: name, Type: kind, Bytes: bytes.length, 'Drive ID': file.getId(), Published: row ? row.Published : 'No', 'Uploaded by': currentUser_(), Time: new Date() };
  if (row) { Object.assign(row, rec); writeTable_('Media', rows); } else appendRow_('Media', rec);
  return name;
}

function mb_(n) {
  return (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';
}

/** The file's bytes from Drive, or null when it only exists on the site. */
function mediaBlob_(name, rows) {
  const row = (rows || readTable_('Media')).find(r => r.Name === name);
  if (!row || !row['Drive ID']) return null;
  return DriveApp.getFileById(row['Drive ID']).getBlob();
}
