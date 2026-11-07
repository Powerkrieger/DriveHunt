# TODO / known limitations

Tracked rough edges, most useful first. In-app tasks for the actual hunt live in
the **Aufgaben** list (📋); this file is for development.

## Navigation redesign — remaining

- **Unify the left tool rail.** Treiben is now a floating button + on-demand
  panel, and Settings/offline/Aufgaben are consolidated. Still to do: turn the
  markers (📌) and measure (📏) map controls into the same labelled left-rail
  buttons as Treiben, with a consistent look and order, and restyle the leaflet
  zoom/layers/GPS controls to match. (Report: "buttons have a weird aesthetik
  and ordering.")
- **Marker popups on phones.** The marker *create/edit form* opens as a centred
  modal on narrow screens; make the read-only info popup (tap a marker) do the
  same, so nothing opens off the screen edge on a phone.

## Other

- **Offline write queue.** Offline support is read-only: the app opens and shows
  the last fields/drives/markers without signal (service worker + Settings → tile
  download), but new markers/edits still need a connection to sync. No queue yet
  that replays writes once back online.
