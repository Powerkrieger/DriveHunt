'use strict';
// Offline support: registers the service worker and adds a "⤓" control that
// pre-downloads the map tiles for the Högel area, so the whole app and map work
// in the field without mobile signal. GPS itself never needs the network.

(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }

  // Base layers to pre-download (XYZ templates; the DOP20 WMS layer caches as
  // you view it instead). {s}-free templates, matched to app.js.
  const LAYERS = [
    { name: 'OpenStreetMap', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
    { name: 'Luftbild Esri', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
  ];
  const ZMIN = 11, ZMAX = 18; // whole-town overview down to very close; z19 caches as you pan
  const MAX_TILES = 20000; // safety cap (~5×5 km town to z18 ≈ 9k tiles/layer-pair)
  const CONCURRENCY = 6;

  const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2tile = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  const clamp = (v, z) => Math.max(0, Math.min(2 ** z - 1, v));

  function tileUrls(bounds) {
    const urls = [];
    const w = bounds.getWest(), e = bounds.getEast(), s = bounds.getSouth(), n = bounds.getNorth();
    for (let z = ZMIN; z <= ZMAX; z++) {
      const x0 = clamp(lon2tile(w, z), z), x1 = clamp(lon2tile(e, z), z);
      const y0 = clamp(lat2tile(n, z), z), y1 = clamp(lat2tile(s, z), z);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (const l of LAYERS) urls.push(l.url(z, x, y));
    }
    return urls;
  }

  async function download(bounds, onProgress, cancelled) {
    const urls = tileUrls(bounds);
    if (urls.length > MAX_TILES) throw new Error(`Zu viele Kacheln (${urls.length}). Weiter hineinzoomen.`);
    let done = 0, failed = 0, i = 0;
    const total = urls.length;
    async function worker() {
      while (i < urls.length && !cancelled()) {
        const url = urls[i++];
        try {
          // The service worker intercepts this and stores it in the tile cache.
          await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
        } catch {
          failed++;
        }
        onProgress(++done, total, failed);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { total, failed, cancelled: cancelled() };
  }

  // Shared with the settings page (⚙ → Offline-Karten), so the download logic
  // lives in one place and the map's ⤓ control stays a quick shortcut.
  window.Offline = {
    townBounds: () => (typeof boundaryLayer !== 'undefined' && boundaryLayer ? boundaryLayer.getBounds() : map.getBounds()),
    tileCount: (bounds) => tileUrls(bounds).length,
    zoomRange: [ZMIN, ZMAX],
    download, // (bounds, onProgress, cancelled) -> { total, failed, cancelled }
  };

  const OfflineControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      // Outer box holds the button-bar and the panel as siblings, so the
      // leaflet-bar border wraps only the button (not the whole panel).
      const box = L.DomUtil.create('div', 'offline-control');
      const bar = L.DomUtil.create('div', 'leaflet-bar', box);
      const button = L.DomUtil.create('a', '', bar);
      button.href = '#';
      button.title = 'Offline-Karte laden';
      button.textContent = '⤓';
      let running = false, cancel = false;

      const panel = L.DomUtil.create('div', 'offline-panel hidden', box);
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);

      const show = (html) => { panel.innerHTML = html; panel.classList.remove('hidden'); };
      const hide = () => panel.classList.add('hidden');

      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (running) { cancel = true; return; }
        const bounds = (typeof boundaryLayer !== 'undefined' && boundaryLayer) ? boundaryLayer.getBounds() : map.getBounds();
        const count = tileUrls(bounds).length;
        show(
          `<p>Karte für die Jagd offline speichern?</p>` +
          `<p class="muted">Högel · Zoom ${ZMIN}–${ZMAX} · OSM + Luftbild Esri · ca. ${count} Kacheln</p>` +
          `<div class="row"><button class="go primary">Laden</button><button class="no">Abbrechen</button></div>`
        );
        panel.querySelector('.no').onclick = hide;
        panel.querySelector('.go').onclick = async () => {
          running = true; cancel = false;
          button.classList.add('active');
          try {
            const r = await download(bounds, (d, t, f) => {
              show(`<p>Lade Kacheln… <strong>${d}/${t}</strong>${f ? ` (${f} fehlgeschlagen)` : ''}</p>` +
                `<div class="row"><button class="no">Stopp</button></div>`);
              panel.querySelector('.no').onclick = () => { cancel = true; };
            }, () => cancel);
            show(
              (r.cancelled ? `<p>Abgebrochen.</p>` : `<p>✓ Offline-Karte gespeichert.</p>`) +
              `<p class="muted">${r.total - r.failed}/${r.total} Kacheln${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}. ` +
              `Daten (Felder, Treiben, Marker) werden beim letzten Online-Besuch gespeichert.</p>` +
              `<div class="row"><button class="no">Schließen</button></div>`
            );
            panel.querySelector('.no').onclick = hide;
          } catch (err) {
            show(`<p class="error">${err.message}</p><div class="row"><button class="no">Schließen</button></div>`);
            panel.querySelector('.no').onclick = hide;
          } finally {
            running = false; cancel = false;
            button.classList.remove('active');
          }
        };
      });
      return box;
    },
  });

  const wait = setInterval(() => {
    if (typeof map === 'undefined' || !map) return;
    clearInterval(wait);
    new OfflineControl().addTo(map);
  }, 200);
})();
