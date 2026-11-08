'use strict';
/*
 * Service worker for Drückjagd Högel — makes the app usable in the field with
 * poor or no mobile signal.
 *
 * Strategy (kept deliberately conservative so live use never breaks):
 *  - App shell (HTML + same-origin JS/CSS/images): network wins when online so
 *    web updates still reach phones; cache is only the offline fallback.
 *  - Map data (GET /api/geo, /api/hunts, /api/markers, /api/me): network-first,
 *    fall back to the last good response when offline. Only 2xx are cached.
 *  - Map tiles (OSM / Esri / DOP20): cache-first (tiles don't change), so a tile
 *    seen once — or pre-downloaded via the ⤓ button — renders without signal.
 *  - /api/events (SSE) and every non-GET request are never touched.
 */

const SHELL = 'dh-shell-v7';
const DATA = 'dh-data-v1';
const TILES = 'dh-tiles-v1';
const KEEP = new Set([SHELL, DATA, TILES]);

const SHELL_ASSETS = [
  '/', '/index.html',
  '/app.css', '/app.js', '/settings.js', '/export.js', '/sim.js', '/geometry.js', '/sketch.js',
  '/markers.js', '/todos.js', '/measure.js', '/locate.js', '/fields-edit.js', '/offline.js',
  '/icon.svg', '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/images/layers.png', '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet/images/marker-icon.png', '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/geoman/leaflet-geoman.css', '/vendor/geoman/leaflet-geoman.min.js',
  '/vendor/polygon-clipping/polygon-clipping.umd.min.js',
];

// Cross-origin tile servers used by the base layers.
const TILE_HOSTS = new Set([
  'tile.openstreetmap.org',
  'server.arcgisonline.com',
  'dienste.gdi-sh.de',
]);

const DATA_PATHS = ['/api/geo', '/api/hunts', '/api/markers', '/api/todos', '/api/me'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Store 2xx and opaque (cross-origin, no-cors) tile responses alike.
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

// Serve the shell from cache at once and refresh it in the background.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fetching;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Live updates stream: let the browser handle it directly.
  if (url.pathname === '/api/events') return;

  // Map tiles (cross-origin): cache-first.
  if (TILE_HOSTS.has(url.hostname)) {
    e.respondWith(cacheFirst(req, TILES));
    return;
  }

  // Only our own origin beyond this point.
  if (url.origin !== self.location.origin) return;

  // Map data we want available offline: network-first.
  if (DATA_PATHS.includes(url.pathname)) {
    e.respondWith(networkFirst(req, DATA));
    return;
  }
  // Other API calls (login, writes already excluded by method): network only.
  if (url.pathname.startsWith('/api/')) return;

  // Page navigation: network-first so updates flow; cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      networkFirst(req, SHELL).catch(async () => (await caches.match('/')) || Response.error())
    );
    return;
  }

  // Static shell assets: instant from cache, refreshed in the background.
  e.respondWith(staleWhileRevalidate(req, SHELL));
});
