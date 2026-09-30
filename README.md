# Hardband Photos (PWA)

Static, no-build Progressive Web App for hardband inspection photos. Data lives on the phone (IndexedDB) and,
optionally, in a **shared team library** (Supabase), so the whole crew sees the same photos and tags.

## Files
- `index.html`, `app.js`, `styles.css`: the app (vanilla JS)
- `config.js`: team-library settings (Supabase Project URL + publishable key). **Empty = local-only**, exactly like before
- `sync.js`: optional sync engine (plain `fetch` against Supabase Auth / REST / Storage, no SDK, nothing loaded from a CDN)
- `supabase/setup.sql`: run once in the Supabase SQL Editor (tables, indexes, RLS, private `hardband` bucket, seed rows)
- `supabase/migrations/002_stage.sql`: adds `photos.stage` to a project that was set up before the Before/After stage existed
- `SUPABASE_SETUP.md`: click-by-click setup for a non-developer
- `manifest.webmanifest`, `sw.js`: installable + offline app shell (bump `VERSION` in sw.js when files change)
- `vendor/jszip.min.js`: JSZip 3.10.1 (bundled locally for offline ZIP export/import)
- `icons/`: PNG icons (regenerate with `python3 make_icons.py`)
- `screenshots/`: mobile screenshots from the automated test

## Before / After hardband stage
Every photo has a stage: `pre` = taken during inspection **before** hardbanding, `post` = **after** hardbanding.
Photos saved before this existed have no stage and count as `post`.
- The photo form starts with a two-button toggle, *Before hardband (inspection)* / *After hardband*, defaulting to the
  stage used last. After hardband is the original full form with the condition chips Good, Rejected wire, Excessive
  porosity, Cracks, Needs repair, Eccentric band. Before hardband is a short inspection screen: rig + "Before hardband"
  header, serial number (focused), chips No hardband needed / Reapply / Repair, and everything else under
  *More details*. Switching stage never clears typed notes (chips only add text to the notes).
- **🔍 Start inspection** (home screen): a sheet whose only required field is the rig name (type it or pick a
  suggestion; a case-insensitive match reuses the rig, otherwise it is created; customer optional, defaults to the
  last-used one). **📷 Open camera** is a `<label for="camInput">` (`capture="environment"`), so the camera opens in
  the same tap. Each photo lands in the Before form for that rig; a blank serial asks "Save without a serial number?"
  (Add serial / Save anyway); **📷 Next photo** reopens the camera. An "Inspecting: [rig]" strip with **Done** shows
  until Done is tapped or the user goes back to the home screen.
- Tiles, the photo detail and the saved screen show a BEFORE / AFTER badge. Search matches "before", "pre",
  "inspection" / "after", "post", and the Filter sheet has a Stage filter.
- **Compare Before / After**: a photo whose serial (ignoring case and spaces) also has a photo of the other stage gets
  a *⇄ Compare Before / After* button (and its joint in the folder a ⇄ marker). The comparison shows both photos with
  BEFORE / AFTER labels, serial, rig, customer, date and condition notes: stacked on a phone, side by side in
  landscape. With several photos of one stage it starts with the newest and *⇆ Show older* cycles through them.
  *Share / Save comparison* draws one JPEG (canvas) and shares it with `navigator.share` (files), else downloads it.
  Folder joints are grouped by that same serial key.
- Export: `stage` column in metadata.csv, `stage` in metadata.json, and `_Before_` / `_After_` in JPEG file names.
- Team sync: `stage` column on `photos` (`supabase/migrations/002_stage.sql`). Until that migration is run, the app
  uploads rows without `stage` (it detects PostgREST's `PGRST204` "Could not find the 'stage' column") and re-uploads
  those photos once the column exists, so sync never stops. Older app versions don't send `stage`; an upsert only
  sets the columns it sends, so they can't erase it.

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
Both suites serve the app themselves on their own ports (no separate web server needed) and never touch the live
team project.
- `/workspace/.pwvenv/bin/python /workspace/hbtest/test_app.py`: the local-only suite (app served with an empty
  `config.js`), including the Before/After stage. Stage screenshots go to `hbtest/shots/`.
- `/workspace/.pwvenv/bin/python /workspace/hbtest/test_sync.py`: two phones against an in-memory fake Supabase
  (`hbtest/mock_supabase.py`), including the upgrade from the current `main` version with photos already on the phone,
  a server without the `stage` column (then migrated), and a phone still on the old version editing a Before photo.

## Hosting
Any static HTTPS host works (service workers and install need HTTPS; `localhost` also works for testing).
All paths are relative, so it can live in a sub-folder. Local test: `python3 -m http.server 8765` in this folder.

## iPhone use
Open the URL in Safari → Share → Add to Home Screen, then always use the Home Screen icon.
Home Screen apps have separate storage from Safari tabs. Export a backup ZIP regularly (⤓ button).
