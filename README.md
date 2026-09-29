# Hardband Photos (PWA)

Static, no-build Progressive Web App for hardband inspection photos. All data stays on the phone (IndexedDB).

## Files
- `index.html`, `app.js`, `styles.css` — the app (vanilla JS)
- `manifest.webmanifest`, `sw.js` — installable + offline app shell (bump `VERSION` in sw.js when files change)
- `vendor/jszip.min.js` — JSZip 3.10.1 (bundled locally for offline ZIP export/import)
- `icons/` — PNG icons (regenerate with `python3 make_icons.py`)
- `screenshots/` — mobile screenshots from the automated test

## Hosting
Any static HTTPS host works (service workers and install need HTTPS; `localhost` also works for testing).
All paths are relative, so it can live in a sub-folder. Local test: `python3 -m http.server 8765` in this folder.

## iPhone use
Open the URL in Safari → Share → Add to Home Screen, then always use the Home Screen icon.
Home Screen apps have separate storage from Safari tabs. Export a backup ZIP regularly (⤓ button).
