#!/usr/bin/env python3
"""
Makes the guide's step videos smaller (H.264 + AAC mono, same picture size up to 854 px), so the site
stays under GitHub Pages' 1 GB limit and phones on weak internet load them faster.

  python3 tools/shrink_videos.py              # preview: encodes into a cache, changes NOTHING in the repo
  python3 tools/shrink_videos.py --apply      # uses the preview's files: replaces videos, commits (no push)
  python3 tools/shrink_videos.py --apply --drive-ids ids.json   # also records each original's Drive ID

What --apply does
  * each smaller video gets a new name (first 16 hex of its SHA-256, like the editor), so phones
    download it instead of keeping the old copy;
  * content/content.json points to the new names; the old big files are removed from the site;
  * tools/video-backup.json records, for EVERY replaced video: old name, new name, sizes, where it is
    used (job, step number, step ID, text), the commit that still holds the original, and its Drive
    ID. The editor reads this file and switches the names in its Sheet, so Publish never puts the
    big files back.

Nothing is deleted for good: the originals stay in the editor's Drive folder and in git history.
Restore one:  git show <oldCommit>:media/<old>  > original.mp4
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, 'content', 'content.json')
MEDIA = os.path.join(ROOT, 'media')
BACKUP = os.path.join(ROOT, 'tools', 'video-backup.json')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'coolteck-shrink')

CRF = 28              # x264 quality (lower = better and bigger); 28 looked the same as the originals
AUDIO = '96k'         # mono AAC: the voice in the video is the instruction, so a little extra
MAX_SIDE = 854        # 480p
MAX_FPS = 30
MIN_SAVING = 0.20     # keep the new file only if it is at least this much smaller


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout


def git(*args):
    return run(['git', '-C', ROOT] + list(args)).strip()


def probe(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))
    v = next((s for s in data['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in data['streams'] if s['codec_type'] == 'audio'), None)
    rate = v.get('avg_frame_rate', '0/1') if v else '0/1'
    num, den = (rate.split('/') + ['1'])[:2]
    fps = float(num) / float(den) if float(den or 0) else 0
    return {
        'codec': v['codec_name'] if v else '', 'w': int(v['width']) if v else 0, 'h': int(v['height']) if v else 0,
        'fps': fps, 'audio': a['codec_name'] if a else '', 'channels': int(a.get('channels', 0)) if a else 0,
        'duration': float(data['format'].get('duration', 0)), 'bitrate': int(data['format'].get('bit_rate', 0)),
    }


def describe(p):
    return '%s %dx%d %.1f Mb/s%s' % (p['codec'], p['w'], p['h'], p['bitrate'] / 1e6,
                                     (', ' + p['audio'] + (' stereo' if p['channels'] == 2 else ' mono')) if p['audio'] else ', no sound')


def encode(src, dst, p):
    vf = []
    if max(p['w'], p['h']) > MAX_SIDE:
        vf.append('scale=%s' % ('%d:-2' % MAX_SIDE if p['w'] >= p['h'] else '-2:%d' % MAX_SIDE))
    if p['fps'] > MAX_FPS + 0.5:
        vf.append('fps=%d' % MAX_FPS)
    tmp = dst + '.part.mp4'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', str(CRF), '-profile:v', 'high', '-pix_fmt', 'yuv420p']
    if vf:
        cmd += ['-vf', ','.join(vf)]
    cmd += ['-c:a', 'aac', '-b:a', AUDIO, '-ac', '1', '-movflags', '+faststart', '-map_metadata', '-1', tmp]
    run(cmd)
    out = probe(tmp)
    if out['codec'] != 'h264' or abs(out['duration'] - p['duration']) > 0.5 or (p['audio'] and not out['audio']):
        os.remove(tmp)
        raise RuntimeError('the new file does not match the original (%s)' % describe(out))
    os.replace(tmp, dst)


def sha16(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:16]


def uses(content):
    """media name -> places it is used, in guide order."""
    jobs = {o['id']: o['title'] for o in content['operations']}
    out = {}
    for job, steps in content['steps'].items():
        for i, s in enumerate(steps, 1):
            v = s.get('video') or ''
            if v.startswith('media/'):
                out.setdefault(v[6:], []).append({
                    'job': job, 'jobTitle': jobs.get(job, ''), 'step': i, 'stepId': s.get('id', ''),
                    'models': s.get('models') or [], 'text': (s.get('text') or '')[:80],
                })
    return out


def mb(n):
    return '%.1f MB' % (n / 1e6)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true', help='replace the videos in the repo and commit (no push)')
    ap.add_argument('--drive-ids', help='JSON {file name: Drive ID} of the originals, recorded in the backup file')
    args = ap.parse_args()

    for tool in ('ffmpeg', 'ffprobe', 'git'):
        if not shutil.which(tool):
            sys.exit(tool + ' is not installed.')
    if args.apply and git('status', '--porcelain', '--', 'content', 'media', 'tools/video-backup.json'):
        sys.exit('content/, media/ or the backup file has uncommitted changes. Commit or undo them first.')
    if args.apply:
        git('fetch', '-q', 'origin')
        if git('rev-parse', 'HEAD') != git('rev-parse', 'origin/main'):
            sys.exit('This copy is not the same as the site (origin/main). Run: git pull --rebase')

    content = json.load(open(CONTENT, encoding='utf-8'))
    backup = json.load(open(BACKUP, encoding='utf-8')) if os.path.exists(BACKUP) else {'videos': []}
    done = {e['new'] for e in backup['videos']}           # already shrunk: never shrink twice
    drive = json.load(open(args.drive_ids)) if args.drive_ids else {}
    placed = uses(content)
    os.makedirs(CACHE, exist_ok=True)

    plan, total_old, total_new = [], 0, 0
    print('%-22s %-38s %9s %9s  %s' % ('video', 'used in', 'now', 'new', 'result'))
    for name in sorted(placed, key=lambda n: (placed[n][0]['job'], placed[n][0]['step'])):
        src = os.path.join(MEDIA, name)
        where = ', '.join('%s #%d' % (u['job'], u['step']) for u in placed[name])
        if not os.path.exists(src):
            print('%-22s %-38s  missing from media/ (skipped)' % (name, where[:38]))
            continue
        old_bytes = os.path.getsize(src)
        total_old += old_bytes
        if name in done:
            total_new += old_bytes
            print('%-22s %-38s %9s %9s  already small' % (name, where[:38], mb(old_bytes), ''))
            continue
        p = probe(src)
        cached = os.path.join(CACHE, '%s.crf%d.a%s.mp4' % (name, CRF, AUDIO))
        if not os.path.exists(cached):
            try:
                encode(src, cached, p)
            except Exception as e:   # noqa: BLE001 - report and keep going
                total_new += old_bytes
                print('%-22s %-38s %9s %9s  FAILED: %s' % (name, where[:38], mb(old_bytes), '', e))
                continue
        new_bytes = os.path.getsize(cached)
        must = p['codec'] != 'h264'                         # e.g. AV1: many phones can't play it
        keep = must or new_bytes <= old_bytes * (1 - MIN_SAVING)
        total_new += new_bytes if keep else old_bytes
        why = ('convert (%s)' % p['codec']) if must else ('-%d%%' % round(100 * (1 - new_bytes / old_bytes)))
        print('%-22s %-38s %9s %9s  %s' % (name, where[:38], mb(old_bytes), mb(new_bytes),
                                           why if keep else 'keep original (only %s)' % why))
        if keep:
            plan.append({'old': name, 'cached': cached, 'oldBytes': old_bytes, 'newBytes': new_bytes, 'probe': p})

    print('\nAll videos: %s -> %s (%d to replace)' % (mb(total_old), mb(total_new), len(plan)))
    if not args.apply:
        print('Preview only: nothing in the repo was changed. Encoded files are in ' + CACHE)
        return
    if not plan:
        print('Nothing to replace.')
        return

    old_commit = git('rev-parse', 'HEAD')
    today = datetime.date.today().isoformat()
    rename = {}
    for item in plan:
        new = sha16(item['cached']) + '.mp4'
        shutil.copyfile(item['cached'], os.path.join(MEDIA, new))
        rename['media/' + item['old']] = 'media/' + new
        backup['videos'].append({
            'old': item['old'], 'new': new, 'date': today,
            'oldBytes': item['oldBytes'], 'newBytes': item['newBytes'],
            'oldFormat': describe(item['probe']), 'newFormat': describe(probe(os.path.join(MEDIA, new))),
            'usedIn': placed[item['old']],
            'oldCommit': old_commit, 'driveId': drive.get(item['old'], ''),
        })
    for steps in content['steps'].values():
        for s in steps:
            if s.get('video') in rename:
                s['video'] = rename[s['video']]
    # The old files are removed from the site only when nothing else (a picture, a sound) still uses them.
    still = json.dumps(content)
    for item in plan:
        if ('media/' + item['old']) not in still:
            git('rm', '-q', 'media/' + item['old'])

    backup['about'] = ('Videos replaced by smaller copies (tools/shrink_videos.py). For each one: where it is used, '
                       'and where the ORIGINAL is kept: in the editor\'s Drive folder (driveId) and in git '
                       '(git show <oldCommit>:media/<old> > original.mp4). The editor applies old -> new to its Sheet.')
    backup['videos'].sort(key=lambda e: (e['usedIn'][0]['job'], e['usedIn'][0]['step']) if e['usedIn'] else ('', 0))
    with open(BACKUP, 'w', encoding='utf-8') as f:
        json.dump({'about': backup['about'], 'videos': backup['videos']}, f, ensure_ascii=False, indent=1)
        f.write('\n')
    with open(CONTENT, 'w', encoding='utf-8') as f:
        json.dump(content, f, ensure_ascii=False, indent=1)
        f.write('\n')
    git('add', 'content/content.json', 'tools/video-backup.json', *['media/' + rename[k][6:] for k in rename])
    saved = sum(i['oldBytes'] - i['newBytes'] for i in plan)
    git('commit', '-q', '-m', 'Smaller step videos (%d replaced, %s saved)\n\nOriginals: Drive folder and commit %s; '
        'see tools/video-backup.json.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' % (len(plan), mb(saved), old_commit[:7]))
    print('Committed. Check it, then push:  git push')


if __name__ == '__main__':
    main()
