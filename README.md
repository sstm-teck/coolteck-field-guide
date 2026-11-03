# CoolTeck Field Guide · دليل الفني – كول تك

Step-by-step Arabic guide for SSTM field technicians working on CoolTeck devices
(replace device, replace sensor, mount battery, …) per model (WROVER, XIAO C3, XIAO S3, XIAO S3 Plus).

- Public site for technicians: big pictures, one step per page, works offline.
- Content is edited by SSTM admins and published here.

## Editor

`editor/` is the admin editor: a Google Apps Script web app (sstm-eg.com accounts only) bound to a
Google Sheet. Admins edit jobs, models and steps there; **Publish** writes `content/content.json` and
the files in `media/` to this repository in one commit, and GitHub Pages updates the site.
Deploy from `editor/`: `clasp push -f && clasp update-deployment AKfycbz_Hm33Y7FZNPEKupGO5JMCdM4ktVhGL9sfmnB-YbmzAaCIsl8ZEulDa3ahswKlRqQJvQ -d "<notes>"` (keeps the same link).
Editor: https://script.google.com/a/macros/sstm-eg.com/s/AKfycbz_Hm33Y7FZNPEKupGO5JMCdM4ktVhGL9sfmnB-YbmzAaCIsl8ZEulDa3ahswKlRqQJvQ/exec
