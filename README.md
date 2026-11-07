# Drivehunt – Drückjagd Högel

Planning tool for a driven hunt (Drückjagd) in the municipality of Högel (25858):
a map of every field, with the drives (Treiben), hunter setup and a step-by-step
simulation of how the drive unfolds.

**Live:** https://hunting.powerizzle.de

This repository holds two parts:

| Path   | What it is |
| ------ | ---------- |
| `web/` | The actual app: a Leaflet web app (vanilla JS, no build step) with a small Node/Express + SQLite backend. A PWA, so it installs and works offline in the field. |
| `app/` | A thin native **Android** shell (Kotlin, `de.powerizzle.drivehunt`) that wraps the live web app in a WebView — location permission, back button, offline screen, persisted login. |

Because the Android app loads the live site, **shipping a web update updates both**;
the APK only needs rebuilding when native code in `app/` changes.

## Quick start (web)

Requires Node.js ≥ 22.5 (for `node:sqlite`).

```bash
cd web
npm install
npm run user -- add admin editor      # prints a generated password
npm start                             # http://localhost:8080
```

Full documentation — features, the simulation model, field-data import, users,
security and deployment — is in **[`web/README.md`](web/README.md)**.

## Android app

```bash
./gradlew assembleDebug                # -> app/build/outputs/apk/debug/app-debug.apk
```

`BuildConfig.BASE_URL` points at the live site, so the shell always shows the
deployed web app. See the *Android app* section of `web/README.md` for details.

## Deploying

Deploy the web app (this is what reaches every browser and the Android shell),
run from `web/`:

```bash
cd web
rsync -av --delete --exclude node_modules --exclude 'data/drivehunt.db*' --exclude data/session.secret ./ power:docker/drivehunt/
ssh power 'cd docker/drivehunt && docker compose up -d --build'
```

Clients pick up the new version on their next load (the service worker re-caches
the app shell). The live database and session secret live only on the server and
are never overwritten by a deploy.

## Project notes

- Open limitations and rough edges: **[`web/TODO.md`](web/TODO.md)**.
- In-app tasks for the actual hunt are the **Aufgaben** list (📋) inside the app,
  not this repo.
