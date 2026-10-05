# Hardband Photos (PWA)

Static, no-build Progressive Web App for hardband inspection photos. Data lives on the phone (IndexedDB) and,
optionally, in a **shared team library** (Supabase), so the whole crew sees the same photos and tags.

## Files
- `index.html`, `app.js`, `styles.css`: the app (vanilla JS)
- `config.js`: team-library settings (Supabase Project URL + publishable key). **Empty = local-only**, exactly like before
- `sync.js`: optional sync engine (plain `fetch` against Supabase Auth / REST / Storage, no SDK, nothing loaded from a CDN)
- `supabase/setup.sql`: run once in the Supabase SQL Editor (tables, indexes, RLS, private `hardband` bucket, seed rows)
- `supabase/migrations/002_stage.sql`: adds `photos.stage` to a project that was set up before the Before/After stage existed
- `supabase/migrations/003_operator.sql`: adds `photos.operator` (who did the work)
- `supabase/migrations/004_rejects.sql`: adds the `rejects` table (reject log) **and** repeats 003, so it is the one file
  to run on a project that has neither yet
- `supabase/migrations/005_reject_work_order.sql`: adds `rejects.work_order` (Work order # on a reject; run after 004).
  One line, no quote characters (like 006)
- `supabase/migrations/006_photo_work_order.sql`: adds `photos.work_order` (Work order # from Start inspection, v13–v15; optional since hbp-v16). One
  line, no quote characters, so it survives iPhone smart quotes
- `supabase/migrations/007_repair_stages.sql`: widens `photos_stage_check` so Repair mid-stages (`repair`, `plasma`, `inlay`, `preheat`)
  sync. File + ASCII one-liner for Dusty's iPhone (smart quotes break SQL — Abby may need to paste)
- `SUPABASE_SETUP.md`: click-by-click setup for a non-developer
- `manifest.webmanifest`, `sw.js`: installable + offline app shell (bump `VERSION` in sw.js **and** `APP_VERSION` in
  app.js, to the same value, when files change; the test suite checks they match)
- `vendor/jszip.min.js`: JSZip 3.10.1 (bundled locally for offline ZIP export/import)
- `icons/`: PNG icons made from Dusty's photo of a hardbanded tool joint (`icons/source.jpg`, the approved 1024 px square
  crop). Regenerate with `python3 make_icons.py` (`--from new-crop.png` replaces the source first), then bump both versions
- `screenshots/`: mobile screenshots from the automated test

## Before / After hardband stage (and Repair mid-stages)
Every photo has a stage: `pre` = **before** hardbanding, `post` = **after** hardbanding. Photos saved before this
existed have no stage and count as `post`.
- **Repair joints** (notes chip token `Repair`, or another non-deleted photo with the same serial + end already marked
  Repair) unlock three extra stages between Before and After, in order: `repair` (*Repair*), `plasma` (*Plasma cut*),
  `inlay` (*Inlay*). Every hardbanded joint: Before → After → Preheat. Repair joints: Before → Repair → Plasma cut →
  Inlay → After → Preheat. Reapply / re-hardband (not Repair): Before → After → Preheat only. Tapping or clearing the Repair
  notes chip redraws the Stage buttons immediately. Mid-stages use the full After form layout (not the Before
  inspection layout). Compare ⇄ still pairs only Before vs After.
- The photo form starts with a two-button toggle, *Before hardband (inspection)* / *After hardband*, defaulting to the
  stage used last (a repair-only last stage falls back to After on a non-repair joint). After hardband is the original
  full form with the condition chips Good, Rejected wire, Excessive porosity, Cracks, Needs repair, Eccentric band.
  Before hardband is a short inspection screen: rig + "Before hardband" header, serial number (focused), chips No
  hardband needed / Reapply / Repair / Eccentric band, and everything else under *More details*. Switching stage never
  clears typed notes (chips only add text to the notes).
- Team sync needs `007_repair_stages.sql` (widen `photos_stage_check` to allow `pre`/`repair`/`plasma`/`inlay`/`post`/`preheat`).
  Until Dusty runs it, repair mid-stages stay on the phone (IndexedDB) and uploads of those keys are rejected by the
  old check.
- **🔍 Start inspection** (home screen): a sheet with, in this order, **Operator (you)** (the saved-operator picker,
  required, *＋ Add new operator…* inline), **Rig name**, **Customer** and **Pipe spec**, then **📷 Open camera**. All
  are native `<select>`s (no `<datalist>` anywhere in the app: iOS home-screen apps crashed on one):
  - *Rig name*: placeholder *— Pick the rig —*, then **＋ Add new rig…** at the top, then the saved rigs. Starts
    unselected every time; required.
  - *Customer*: *— Pick the customer —*, **＋ Add new customer…**, then the saved customers. Starts with the last-used
    customer; required.
  - Choosing *＋ Add new…* shows a plain text box right under the select. The name is saved when the camera opens: a
    case-insensitive / extra-spaces match reuses the existing entry, otherwise a new rig / customer is created and
    synced like any other. With no rigs / customers yet the select holds only the placeholder and *＋ Add new…*.
  - *Pipe spec*: exactly **4.5 Duo**, **4.5 TSDS**, **5" P-Tech R3**, **5" NC50** (fixed ids `spec_45_duo`,
    `spec_45_tsds`, `spec_5_ptech_r3`, `spec_5_nc50`). Default = the last-used spec if it is one of the four, else
    5" P-Tech R3. On load and after every team sync the app makes sure each exists once: an existing entry with the
    same name (case, punctuation, quote style ignored; 4-1/2 = 4.5; "P-Tech 47 R3" = "P-Tech R3") is kept and renamed to
    the exact name (so the old *5" P-Tech 47 R3* keeps its id and its photos), same-name duplicates are merged into it.
    Other older specs stay on their photos and in the photo form but are not offered here.
  - **📷 Open camera** is a `<label for="camInput">` (`capture="environment"`), so the camera opens in the same tap; a
    missing field cancels the tap and shows a message under it (*Pick the rig first.*, *Type the new rig name first.*,
    *Pick the customer first.*, *Pick your name first…*).
  Every photo of the inspection carries the rig, customer, pipe spec and operator. Each photo lands in the Before form
  for that rig (serial numbers used before are offered as tap-to-pick buttons, not a datalist); a blank serial asks
  "Save without a serial number?" (Add serial / Save anyway); **📷 Next photo** reopens the camera. An
  "Inspecting: [rig] · [operator]" strip with **Done** shows until Done is tapped or the user goes back home.
- **Work order #** is no longer asked for or shown anywhere (Start inspection, Log rejected wire, photo detail, folder,
  strip, reject list, search) since hbp-v16. Work orders already stored (v13–v15) are kept on the records, still
  sync, and are still in the CSV / JSON export (`work_order` columns) and import.
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

## Operator (who did the work)
Every record carries an operator, stored as one value **"Name Number"** (e.g. `Dusty 104`). The number is the
identity: the same number is the same operator (so two Dustys are told apart); names ignore case and extra spaces.
It's part of the common photo record, so future record types (e.g. welding) inherit it.
- **Pick, don't type**: a dropdown of saved operators on the *Start inspection* sheet (required there), the
  *👷 Operator* chip at the top of the home screen, and every photo form. *＋ Add new operator…* asks for Name and
  Number (numeric keypad) once; after that it's in the list. A number already used by a different name gets a warning
  with a *Use <existing>* button.
- The phone remembers the last operator (localStorage `hbp.operator`) and pre-selects it on every new photo; each photo
  can still be changed. The list = names added on this phone (`hbp.operators`) + every operator found on the records,
  so with the team library the names reach other phones with their photos.
- Shown on the photo detail, the saved screen, the Inspecting bar, the Before/After comparison and the saved comparison
  JPEG. Records without one show **No operator**.
- Library **Filter → Operator**: All operators, Unassigned (no operator), and every operator found (with counts);
  works with search and the other filters. Tapping an operator name on a photo or comparison shows all their photos.
- Export: `operator` column in metadata.csv / metadata.json; `work_order` right after it (and `workOrder` in
  metadata.json), restored by import.
- Team sync: `photos.work_order` (`supabase/migrations/006_photo_work_order.sql`) with the same fallback as the operator:
  until it's run, rows upload without it, the phone keeps the value (`meta.photoWorkOrderBacklog`, pill ✓ Synced) and
  fills it in afterwards (work_order-only PATCH where still empty).
- Team sync: `operator` column on `photos` (`supabase/migrations/003_operator.sql`). Until it's run, rows upload
  without it (same PGRST204 detection as `stage`) and each phone keeps its operators, then fills them in on the server
  (operator-only PATCH where still empty) once the column exists.

## Reject log (rejected wires per operator)
Each rejected wire can be logged in two taps, and the app counts rejects per operator.
- Home screen: **⛔ Log rejected wire** right under the *👷 Operator* chip → a sheet with the operator (pre-picked from
  the phone; with none set, the same pick-your-name dropdown / *＋ Add new operator…* is required first), the time it
  will be saved with, and **⛔ Log reject**. *Add details* (collapsed, optional) = rig (defaults to the last-used rig),
  serial, short note. Nothing else is required. A toast *Reject logged — Dusty 104* with **Undo** follows; a line under
  the button shows *Your rejects today* and links to the per-operator list.
- **Rejects by operator** (`#/rejects`, also a link under Filter → Operator): one row per operator (same number = same
  operator, case/spaces ignored) with the count and last reject, most rejects first, plus *Unassigned* if any. Tap a
  name: every reject with its date and time (phone's local time), rig / serial / note, and **🗑 Delete** (asks first),
  plus *Show photos*. **⤓ Rejects list (CSV for Excel)** shares/downloads all rejects.
- Filter → Operator options read e.g. *Dusty 104 — 12 photos, 3 rejects* (operators with only rejects are listed too);
  with an operator selected, the results show *⛔ 3 rejects logged ›*.
- Export ZIP: `rejects.csv` (one row per reject, local time, operator + number, rig, serial, work_order, note, logged_by, id),
  `rejects_by_operator.csv` (counts), and `rejects` in metadata.json; import restores missing rejects.
- Storage: IndexedDB store `rejects` (DB version 3). Delete is soft (`deletedAt`) in team mode.
- Team sync: table `public.rejects` (`supabase/migrations/004_rejects.sql`, same RLS as photos: authenticated only, no
  DELETE). Rejects go through the outbox like photos (offline → queued). If the table doesn't exist yet (PostgREST
  `404 PGRST205`, or `42P01` / `42501`), the phone keeps them in `meta.rejectBacklog`, the pill still shows ✓ Synced,
  and it re-checks at most every 5 minutes, then uploads them (last-write-wins by `client_updated_at`).
- Work order # (no longer entered since hbp-v16; older values kept) (`workOrder` on the record, column `rejects.work_order`, `supabase/migrations/005_reject_work_order.sql`).
  Until 005 is run, rejects upload without it (PGRST204 / 42703 detection, like `photos.operator`), each phone keeps
  its work orders (`meta.workOrderBacklog`, pill stays ✓ Synced) and fills them in on the server (work_order-only PATCH
  where still empty) once the column exists; pulling rows without the column never clears a local work order.

## App updates
- `sw.js` installs a new version in the background (files fetched with `cache: 'reload'`, so the 10-minute GitHub
  Pages cache can't slip an older file in) and takes over right away (`skipWaiting` + `clients.claim`).
- The open page checks at launch and whenever it comes back to the foreground (`visibilitychange` / `pageshow`, at most
  once a minute): `registration.update()`, then it asks the newest finished service worker its `VERSION`
  (`postMessage` + `MessageChannel`). If that is newer than `APP_VERSION`, a banner under the header says
  **A new version of the app is ready. Tap to update.** with **Update** / **Not now**. A takeover while the page is
  open (`controllerchange`) shows the banner too. It never reloads by itself.
- **Not now** hides it until the next check. **Update** reloads, except: with an unsaved photo (Add photo form), a
  photo edit, or an inspection in progress it asks first (*Save it first* / *Keep inspecting* or *Update anyway*);
  while a sheet is open its backdrop covers the banner, so typed input can't be lost. Before reloading it waits for
  pending IndexedDB outbox writes; queued team sync continues after the reload.

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
  a server without the `stage` column (then migrated), a phone still on the old version editing a Before photo,
  the operator column, the reject log (no table → kept on the phone → migrated → second phone, undo/delete, offline),
  the reject work order column (no column → kept on the phone → 005 run → filled in, second phone), and the photo
  work order from Start inspection (same, for 006),
  and the four inspection pipe specs against a team that already has the old *5" P-Tech 47 R3* (renamed in place,
  no duplicates on either phone).

## Hosting
Any static HTTPS host works (service workers and install need HTTPS; `localhost` also works for testing).
All paths are relative, so it can live in a sub-folder. Local test: `python3 -m http.server 8765` in this folder.

## iPhone use
Open the URL in Safari → Share → Add to Home Screen, then always use the Home Screen icon.
Home Screen apps have separate storage from Safari tabs. Export a backup ZIP regularly (⤓ button).
