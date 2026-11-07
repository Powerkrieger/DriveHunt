#!/usr/bin/env node
// Imports the official field blocks (Feldblöcke, InVeKoS) of Schleswig-Holstein
// for the municipality in data/boundary.geojson and writes data/fields.geojson.
//
// Source: https://service.gdi-sh.de/SH_OpenGBD/feeds/Atom_SH_Feldblockfinder_OpenGBD/Atom_SH_Feldblockfinder_OpenGBD.xml
// License: CC BY 4.0 / DL-DE-BY 2.0, © Land Schleswig-Holstein
//
// Usage: node scripts/import-feldbloecke.js <FB_*.gpkg>
//   (download Feldbloecke_<year>_GPKG.zip from the feed above and unzip it)
// Run scripts/import-osm.js first if data/boundary.geojson does not exist yet.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const pc = require('polygon-clipping');

const DATA_DIR = path.join(__dirname, '..', 'data');
const gpkgPath = process.argv[2];
if (!gpkgPath) {
  console.error('usage: import-feldbloecke.js <FB_*.gpkg>');
  process.exit(1);
}

// ---- EPSG:4647 (ETRS89 / UTM 32N, easting prefixed with zone "32") <-> WGS84

const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, LON0 = (9 * Math.PI) / 180;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);

function utmToLngLat(x, y) {
  const E = x - 32_000_000 - 500_000;
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * s * s);
  const R1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5;
  const C1 = EP2 * c * c, T1 = t * t, D = E / (N1 * K0);
  const lat =
    phi1 -
    ((N1 * t) / R1) *
      (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lng =
    LON0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5) / 120) / c;
  return [+((lng * 180) / Math.PI).toFixed(7), +((lat * 180) / Math.PI).toFixed(7)];
}

function lngLatToUtm(lng, lat) {
  const phi = (lat * Math.PI) / 180, lam = (lng * Math.PI) / 180;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * (lam - LON0);
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500_000;
  const y =
    K0 *
    (M + N * t * (Aa ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return [x + 32_000_000, y];
}

// ---- GeoPackage geometry blob -> GeoJSON geometry (Polygon / MultiPolygon)

function parseGpkgGeom(buf) {
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error('not a GPKG geometry');
  const envBytes = [0, 32, 48, 48, 64][(buf[3] >> 1) & 7];
  let o = 8 + envBytes;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  function readGeom() {
    const le = buf[o] === 1;
    o += 1;
    const rawType = dv.getUint32(o, le);
    o += 4;
    const type = rawType % 1000; // ISO Z/M variants
    const dims = rawType >= 3000 ? 4 : rawType >= 1000 ? 3 : 2;
    const u32 = () => ((o += 4), dv.getUint32(o - 4, le));
    const ring = () => {
      const n = u32(), pts = [];
      for (let i = 0; i < n; i++) {
        const x = dv.getFloat64(o, le), y = dv.getFloat64(o + 8, le);
        o += 8 * dims;
        pts.push(utmToLngLat(x, y));
      }
      return pts;
    };
    if (type === 3) {
      const n = u32(), rings = [];
      for (let i = 0; i < n; i++) rings.push(ring());
      return { type: 'Polygon', coordinates: rings };
    }
    if (type === 6) {
      const n = u32(), polys = [];
      for (let i = 0; i < n; i++) polys.push(readGeom().coordinates);
      return { type: 'MultiPolygon', coordinates: polys };
    }
    throw new Error('unsupported geometry type ' + rawType);
  }
  return readGeom();
}

const HBN_TO_LANDUSE = { Ackerland: 'farmland', Dauergrünland: 'meadow' };

// ---- main

const boundary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'boundary.geojson'), 'utf8'));
const bCoords = (boundary.geometry.type === 'Polygon' ? [boundary.geometry.coordinates] : boundary.geometry.coordinates).flat(2);
const lngs = bCoords.map((c) => c[0]), lats = bCoords.map((c) => c[1]);
const [minX, minY] = lngLatToUtm(Math.min(...lngs), Math.min(...lats));
const [maxX, maxY] = lngLatToUtm(Math.max(...lngs), Math.max(...lats));

const db = new DatabaseSync(gpkgPath, { readOnly: true });
const table = db.prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'").get().table_name;
const rows = db
  .prepare(
    `SELECT t.FLIK, t.HBN, t.FLAECHE, t.FACHGUELTI, t.geom FROM "${table}" t
     JOIN "rtree_${table}_geom" r ON r.id = t.fid
     WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?`
  )
  .all(minX - 2000, maxX + 2000, minY - 2000, maxY + 2000);

// Planar area in m² of a MultiPolygon in lng/lat (local projection, fine at this scale).
function areaM2(multi) {
  const lat0 = (multi[0][0][0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  let total = 0;
  for (const poly of multi) {
    poly.forEach((ring, i) => {
      let a = 0;
      for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * kx * ring[k + 1][1] * ky - ring[k + 1][0] * kx * ring[k][1] * ky;
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total;
}
const asMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const town = asMulti(boundary.geometry);

const features = [];
for (const r of rows) {
  let geometry = parseGpkgGeom(r.geom);
  // Cut everything outside the town limits. Keep a block if a meaningful part
  // lies inside (drops slivers of neighbouring blocks along the border).
  const whole = asMulti(geometry);
  const inside = pc.intersection(whole, town);
  const aIn = inside.length ? areaM2(inside) : 0;
  if (aIn < 1000 || aIn < 0.1 * areaM2(whole)) continue;
  geometry = inside.length === 1 ? { type: 'Polygon', coordinates: inside[0] } : { type: 'MultiPolygon', coordinates: inside };
  const id = `flik/${r.FLIK}`;
  features.push({
    type: 'Feature',
    id,
    properties: { id, landuse: HBN_TO_LANDUSE[r.HBN] || 'other', hbn: r.HBN, name: null, flik: r.FLIK, valid: r.FACHGUELTI },
    geometry,
  });
}
features.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(DATA_DIR, 'fields.geojson'), JSON.stringify({ type: 'FeatureCollection', attribution: 'Feldblöcke &copy; Land Schleswig-Holstein (DL-DE-BY 2.0)', features }));
const byHbn = {};
for (const f of features) byHbn[f.properties.hbn] = (byHbn[f.properties.hbn] || 0) + 1;
console.log(`${rows.length} blocks in bbox, ${features.length} inside ${boundary.properties.name}:`, byHbn);
