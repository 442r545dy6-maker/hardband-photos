# Hardband Photos (PWA)

Static, no-build Progressive Web App for hardband inspection photos. Data lives on the phone (IndexedDB) and,
optionally, in a **shared team library** (Supabase), so the whole crew sees the same photos and tags.

## Files
- `index.html`, `app.js`, `styles.css`: the app (vanilla JS)
- `config.js`: team-library settings (Supabase Project URL + publishable key). **Empty = local-only**, exactly like before
- `sync.js`: optional sync engine (plain `fetch` against Supabase Auth / REST / Storage, no SDK, nothing loaded from a CDN)
- `supabase/setup.sql`: run once in the Supabase SQL Editor (tables, indexes, RLS, private `hardband` bucket, seed rows)
- `SUPABASE_SETUP.md`: click-by-click setup for a non-developer
- `manifest.webmanifest`, `sw.js`: installable + offline app shell (bump `VERSION` in sw.js when files change)
- `vendor/jszip.min.js`: JSZip 3.10.1 (bundled locally for offline ZIP export/import)
- `icons/`: PNG icons (regenerate with `python3 make_icons.py`)
- `screenshots/`: mobile screenshots from the automated test

## Shared team library (optional)
1. Follow `SUPABASE_SETUP.md` (free Supabase project → run `supabase/setup.sql` → create the team user → turn off sign-ups).
2. Paste the Project URL and publishable key into `config.js`, bump `VERSION` in `sw.js`, and publish.
3. On each phone: ⤓ Backup → **Team sign-in** (shared team email + password, entered once).

How it works:
- IndexedDB stays the local cache the UI reads, so the app works offline. Every local change goes into an `outbox`
  store and uploads when online.
- Pull: on open, on focus/visible, when back online, and every ~60 s. It asks for rows whose server `updated_at` is newer
  than the last pull (with a 60 s overlap).
- Conflicts: last write wins per record, by the phone's edit time (`client_updated_at`). The server trigger ignores
  older writes, so a phone that was offline for days can't overwrite newer edits.
- Deletes are soft (`deleted_at`). The `authenticated` role has no DELETE grant or policy on tables or storage.
- Photos: `photos/<id>.jpg` and `thumbs/<id>.jpg` in the private `hardband` bucket. Thumbnails download eagerly,
  full images when opened (then cached on the phone).
- First sign-in uploads every existing local record and photo (the server keeps whichever edit is newer) and never
  removes anything from the phone. Starter entries use fixed ids (`c_eog`, `r_six`, `s_45r3_450duo`) on every phone and
  on the server. Entries with the same name created separately on different phones (e.g. two "Patterson 801" rigs)
  are merged automatically: photos move to the surviving id, and the duplicate becomes a tombstone with `merged_into`.
- The header pill shows ✓ Synced / ↑ N pending / Offline · N / ⚠ Sync / Signed out. It's hidden when `config.js` is empty.

## Tests
- `python3 -m http.server 8765` in this folder, then `/workspace/.pwvenv/bin/python /workspace/hbtest/test_app.py`
  (the original local-only suite, run with empty config).
- `/workspace/.pwvenv/bin/python /workspace/hbtest/test_sync.py`: two phones against an in-memory fake Supabase
  (`hbtest/mock_supabase.py`), including the upgrade from the current `main` version with photos already on the phone.
  It also needs the 8765 server above for its empty-config check.

## Hosting
Any static HTTPS host works (service workers and install need HTTPS; `localhost` also works for testing).
All paths are relative, so it can live in a sub-folder. Local test: `python3 -m http.server 8765` in this folder.

## iPhone use
Open the URL in Safari → Share → Add to Home Screen, then always use the Home Screen icon.
Home Screen apps have separate storage from Safari tabs. Export a backup ZIP regularly (⤓ button).
