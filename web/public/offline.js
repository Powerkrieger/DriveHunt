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
          // CORS (default mode), not no-cors: the servers send the headers, so the
          // service worker caches a non-opaque response accounted at its true size
          // (~25 KB) instead of the ~7 MB padding applied to opaque responses.
          await fetch(url, { cache: 'no-cache' });
        } catch {
          failed++;
        }
        onProgress(++done, total, failed);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { total, failed, cancelled: cancelled() };
  }

  // Offline map download lives in the settings page (⚙ → Offline-Karten); this
  // module exposes the shared download logic and the service-worker registration.
  window.Offline = {
    townBounds: () => (typeof boundaryLayer !== 'undefined' && boundaryLayer ? boundaryLayer.getBounds() : map.getBounds()),
    tileCount: (bounds) => tileUrls(bounds).length,
    zoomRange: [ZMIN, ZMAX],
    download, // (bounds, onProgress, cancelled) -> { total, failed, cancelled }
  };
})();
