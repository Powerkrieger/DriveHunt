# TODO / known limitations

Tracked rough edges, most useful first. In-app tasks for the actual hunt live in
the **Aufgaben** list (📋); this file is for development.

- **Offline write queue.** Offline support is read-only: the app opens and shows
  the last fields/drives/markers without signal (service worker + ⤓ tile
  download), but new markers/edits still need a connection to sync. No queue yet
  that replays writes once back online.
- **Marker info popup on phones.** The marker *create/edit form* now opens as a
  centred modal on narrow screens; the read-only info popup (tap a marker) is
  still an anchored Leaflet popup. It auto-pans into view, so it's low priority,
  but could get the same modal treatment for consistency.
