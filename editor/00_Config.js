/**
 * CoolTeck Field Guide · Editor (Google Apps Script web app, deployed "as me", sstm-eg.com only).
 *
 * Admins edit jobs, models and steps here. The Google Sheet this script is bound to holds the
 * content; pictures, videos and sounds are kept in a Drive folder. "Publish" turns the sheet into
 * content/content.json, copies the media into the GitHub repo in one commit, and GitHub Pages
 * updates the public site for the technicians (about a minute later).
 *
 * The GitHub token is kept in Script Properties (set from the Settings page), never in the sheet.
 */

const APP_NAME = 'Field Guide Editor';
const SITE_URL = 'https://sstm-teck.github.io/coolteck-field-guide/';
const REPO = 'sstm-teck/coolteck-field-guide';
const BRANCH = 'main';
const CONTENT_PATH = 'content/content.json';
const MEDIA_DIR = 'media/';
const MEDIA_FOLDER_NAME = 'CoolTeck Field Guide · media';

// The "CoolTeck Field Guide Editor" Google Sheet this script is bound to.
const SPREADSHEET_ID = '1aO9VGcDerjaIThAG0FINVtbhLRgP_zCa-ovUXsN6D9A';

// The owner of the script can always open the editor; others are listed in Settings › admins.
const FIRST_ADMINS = 'salah.hassan@sstm-eg.com';

// ---------- sheets ----------
// Jobs and models are identified by a short English link name (it appears in the step links,
// so it can't change after creation). Models lists are comma-separated model IDs; an empty
// Models cell on a step means "every model of the job".
const TABLES = {
  Jobs: {
    headers: ['ID', 'Title', 'Picture', 'Sound', 'Models', 'Order', 'Show'],
    widths: [150, 200, 220, 220, 260, 60, 60], tab: '#21449A',
  },
  Models: {
    headers: ['ID', 'Title', 'Picture', 'Sound', 'Order'],
    widths: [150, 200, 220, 220, 60], tab: '#1F7DBA',
  },
  Steps: {
    headers: ['ID', 'Job', 'Order', 'Models', 'Warning', 'Text', 'Picture', 'Video', 'Sound'],
    widths: [90, 150, 60, 200, 70, 380, 220, 220, 220], tab: '#548235',
  },
  Media: {
    headers: ['Name', 'Type', 'Bytes', 'Drive ID', 'Published', 'Uploaded by', 'Time'],
    widths: [240, 70, 90, 300, 80, 200, 140], tab: '#7F7F7F',
  },
  Settings: {
    headers: ['Key', 'Value', 'Description'],
    widths: [140, 360, 420], tab: '#BF8F00',
  },
  Log: {
    headers: ['Time', 'User', 'Action', 'Item', 'Details'],
    widths: [140, 200, 100, 220, 460], tab: '#A5A5A5',
  },
};
const SHEET_ORDER = ['Jobs', 'Models', 'Steps', 'Settings', 'Media', 'Log'];

// Editable settings (shown on the Settings page) and internal ones (kept by the app).
const SETTINGS = [
  ['title', 'دليل الفني', 'Site title, top of the first screen'],
  ['subtitle', 'كول تك', 'Small line under the title'],
  ['ask_job', 'هتعمل إيه؟', 'Question on the jobs screen'],
  ['ask_job_sound', '', 'Sound for that question'],
  ['ask_model', 'أنهي جهاز؟', 'Question on the models screen'],
  ['ask_model_sound', '', 'Sound for that question'],
  ['ask_done', 'خلصت! الجهاز اشتغل؟', 'Question on the last screen'],
  ['ask_done_sound', '', 'Sound for that question'],
  ['sample', 'Yes', 'Yes = show the "sample content" bar on the site'],
  ['admins', FIRST_ADMINS, 'Google accounts that can open this editor, comma separated'],
  ['last_edit', '', 'Set by the app'],
  ['last_publish', '', 'Set by the app'],
  ['last_commit', '', 'Set by the app'],
];
const INTERNAL_SETTINGS = ['last_edit', 'last_publish', 'last_commit'];

// What each table lets the page change through apiSet.
const EDITABLE = {
  Jobs: ['Title', 'Models', 'Show'],
  Models: ['Title'],
  Steps: ['Models', 'Warning', 'Text'],
};
// Media fields per table and the kind of file each takes.
const MEDIA_FIELDS = {
  Jobs: { Picture: 'image', Sound: 'audio' },
  Models: { Picture: 'image', Sound: 'audio' },
  Steps: { Picture: 'image', Video: 'video', Sound: 'audio' },
};

const MEDIA_MAX_BYTES = { image: 3 * 1024 * 1024, audio: 5 * 1024 * 1024, video: 25 * 1024 * 1024 };
const MEDIA_TYPES = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/svg+xml': 'svg', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/webm': 'weba', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
