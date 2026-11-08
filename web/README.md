# Drückjagd Högel – Web-App

Map of the municipality of Högel (25858) with every field for planning the drives (Treiben) of a hunt.
Live: https://hunting.powerizzle.de

- Town limits: orange, not selectable. Fields: green, forest: dark green, scrub: olive, water: blue.
  Forest, scrub and water can be part of drives just like fields.
- **Editors** create drives: select areas, pick a color and number, draw the direction path (start → bends → end), add notes.
- **Viewers** see all drives, and can focus one and play the simulation.
- All open maps update live when an editor saves.
- **Editors** can also edit fields: draw new ones, split (draw a cut line), reshape, merge, delete, rename, change type
  (e.g. a pond missing from OSM: draw it, set type „Gewässer“).
  Drives that use an edited field follow automatically (split → all pieces, merge → the merged field).
- **Setup (Aufstellung)** per drive (editors): place automatically, or draw a rough drivers' / standers' line
  that gets filled evenly; then drag single hunters, right-click / long press removes one. The simulation starts from it.
- All drawing (direction path, hunters' lines, new fields, cut lines) works point by point: every point can be dragged,
  right-click / long press removes it; the action bar at the bottom of the map has Zurück / Fertig / Abbrechen
  (Enter / Esc). Taps snap to field corners when drawing fields.
- Everything is cut to the town limits (import and when editors draw or change fields).
- **Markers** (📌, all users): meeting point, stand, parking, danger, game seen, other – with label and note. Own markers
  (editors: all) can be dragged, edited and deleted; everyone sees them live. Toggle via the layer control.
- **Measuring tool** (📏, all users): distances per segment and total, area from 3 points.
- **A4 export** (🖨 in a focused Treiben, all users): an export mode shows an A4-proportioned
  viewfinder frame on the map; pan/zoom to frame the area, pick Hoch-/Querformat, and optionally
  show all drives and/or hide the number badges. „Als PDF drucken" renders a dedicated A4-sized map
  of exactly that frame and opens the browser print dialog (Save as PDF or print). Uses DOM tiles +
  SVG overlays (`public/export.js`), so no canvas/cross-origin issues; raster tiles print at screen
  resolution.
- **Settings** (⚙ in the panel header, all users): own account + password change; default base map; default
  simulation values (prefill new drives / the sim panel); light/dark/auto theme; and offline-map management
  (download Högel, show/clear the cached tiles). Preferences are per-device (localStorage); only the password
  change hits the server (`POST /api/password`, scrypt like the CLI).
- Base maps: OpenStreetMap, SH aerial imagery (DOP20, very detailed), Esri aerial imagery.
- **Offline (⤓, all users):** a service worker (`public/sw.js`) caches the app shell and map data, so the app
  still opens and shows the last fields/drives/markers without signal; GPS works offline anyway. The ⤓ control
  (`public/offline.js`) pre-downloads OSM + Esri tiles for the whole town (zoom 12–17) for use in the field; DOP20
  (WMS) tiles are cached as you view them. New markers/edits still need signal to sync (no offline write queue yet).

## Simulation

The direction path (2+ points) sets the drive direction and may have bends. Positions are computed along the path
(distance along it, offset across it); the line always stands perpendicular to the path and swings round bends.
Every hunter gets a lane across the typical width of the drive area:

- **Drivers (Treiber)** enter along the rear field edge and walk forward. Lanes whose area only starts further ahead
  are walked in formation (shown faded until the driver reaches the area). Where the area narrows, drivers slide inward
  along the edge instead of stopping, so the flanks keep their lead until they reach the standers.
- **Several fields in a row** are driven field by field: the line crosses the whole width of the current field (it widens
  and narrows with the field's side borders), waits at the boundary until everyone has arrived, walks over (1.5× pace)
  and lines up again along the next field's rear edge. Fields side by side are driven together. The standers only start
  walking once the drivers are in the last field (at the 300 m mark).
- **Walking is simulated step by step** (2 s): everyone follows their place in the formation but never faster than
  *Max. km/h* (default 5), stays inside the field they are driving, and neighbours never swap sides (paths don't cross).
  Whoever has further to go (outer side of bends, sideways shifts, walking over) falls behind and catches up.
  **Dauer** = until the slowest person has arrived; shown with that person and their walking distance.
  „Spuren anzeigen“ draws everyone's path.
- With a fixed setup every hunter starts from the placed position and keeps their offset (e.g. flanks placed ahead
  stay ahead). The outer ends (flanks) are ahead by *Flanke m*, so the line forms a cup.
- **300 m mark**: when the drivers are 300 m from the nearest stander, the drivers' line stops and straightens (like at
  a field boundary, but without re-forming), then continues.
- **Standers (Schützen)** wait where placed (default: far field edge). They close in slowly (*Schützen km/h*, default
  1.5) as one straight line across the direction of travel: the line sets off from the furthest stander and reaches the
  nearest one when the drivers have straightened at the 300 m mark; everyone joins as the line passes.
- Near a field's far boundary everyone keeps their place across the field and walks straight to the boundary in their
  own lane, so a slanted boundary is reached staggered instead of the line squeezing into its last corner.
- A placed setup forms the standard straight line (flanks ahead) within the first 80 m.
- Once the gap is **≤ 350 m**, the standers walk towards the drivers until both lines meet.

Number of drivers and standers, walking speed and flank lead can be adjusted in the side panel. The logic lives in `public/sim.js`, with no dependencies, so it can be reused in the Android app.

## Running

Requirements: Node.js ≥ 22.5 (for `node:sqlite`).

```bash
npm install
npm run user -- add admin editor          # prints a generated password
npm run user -- add jagd viewer MeinPasswort
npm start                                 # http://localhost:8080  (PORT=... to change)
```

More user commands: `npm run user -- list | passwd <name> [pw] | del <name>`

### Deployment (powerserver)

Runs on `ssh power` in `/home/power/docker/drivehunt`. Caddy (`/home/power/docker/caddy`) terminates HTTPS
for `hunting.powerizzle.de` and proxies to `drivehunt:8080` over the external Docker network `web`.

```bash
# from this directory, on the dev machine
rsync -av --delete --exclude node_modules --exclude 'data/drivehunt.db*' --exclude data/session.secret ./ power:docker/drivehunt/
ssh power 'cd docker/drivehunt && docker compose up -d --build'
# users
ssh power 'cd docker/drivehunt && docker compose exec drivehunt node scripts/user.js add <name> <viewer|editor>'
```

On the server, `data/drivehunt.db*` and `data/session.secret` are the live state (back them up); `data/*.geojson` is only build input for the image.

## Field data

Default: the official **field blocks (Feldblöcke, InVeKoS) of Schleswig-Holstein**. They follow permanent borders (Knicks, roads, ditches)
and match the aerial imagery much better than OSM. Blocks can contain several crops; split them in the app if needed.

```bash
# download Feldbloecke_<year>_GPKG.zip from
# https://service.gdi-sh.de/SH_OpenGBD/feeds/Atom_SH_Feldblockfinder_OpenGBD/Atom_SH_Feldblockfinder_OpenGBD.xml
unzip Feldbloecke_2026_GPKG.zip
npm run import-feldbloecke -- FB_20260101.gpkg
```

Forest, scrub and water come from OpenStreetMap, clipped to the town limits (`data/nature.geojson`):

```bash
npm run import-osm                          # Högel: forest/scrub/water (+ boundary.geojson if missing)
npm run import-osm -- <relationId> --boundary  # other municipality (re-downloads the town limits)
npm run import-osm -- --fields              # fields from OSM too (other federal states)
```

The existing `boundary.geojson` is kept unless `--boundary` is passed; some Overpass mirrors serve outdated geometry.

Editor changes are stored in the database as an overlay (hidden base fields + custom fields), so they survive a re-import.
Custom fields that were split from a block keep working even if the block changes; drives referencing a base field that
disappears after a re-import lose that field.

## Security

"Light" password protection, as intended: every page and API call requires a login. Passwords are stored with scrypt, sessions are signed cookies (30 days), and 5 failed attempts trigger a 1-minute lockout per IP.

## Android app

`../app` (Android Studio project in the repository root) is a native shell around the live web app
(`BuildConfig.BASE_URL` = https://hunting.powerizzle.de/), so web updates reach the app without a new release.
Native parts: location permission for „📍 Mein Standort“, back button (closes tools / views in the web app first via
`window.drivehuntBack()`), offline screen with retry, external links open in the browser, login cookie persisted.

```bash
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

Debug builds allow `chrome://inspect` (WebView remote debugging). Library versions are pinned to ones that work with
compileSdk 36 / AGP 9.0.1 (newer androidx releases need SDK 37 and AGP 9.1).
