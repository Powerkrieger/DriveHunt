#!/usr/bin/env node
// Downloads data for one municipality from OpenStreetMap (Overpass API) and
// stores it as static GeoJSON in data/:
//   boundary.geojson  town limits (if missing, or with --boundary to refresh)
//   nature.geojson    forest, scrub and water, clipped to the town limits (always)
//   fields.geojson    farmland/meadows (only with --fields; in Schleswig-Holstein
//                     use import-feldbloecke.js instead, it is far more accurate)
//
// Usage: node scripts/import-osm.js [osmRelationId] [--fields] [--boundary]
//        default relation 1416733 = Gemeinde Högel (25858)

const fs = require('node:fs');
const path = require('node:path');
const osmtogeojson = require('osmtogeojson');
const pc = require('polygon-clipping');

const args = process.argv.slice(2);
const WITH_FIELDS = args.includes('--fields');
const REFRESH_BOUNDARY = args.includes('--boundary');
const RELATION_ID = Number(args.find((a) => /^\d+$/.test(a)) || process.env.OSM_RELATION || 1416733);
const FIELD_LANDUSE = ['farmland', 'meadow', 'grass', 'grassland'];
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const DATA_DIR = path.join(__dirname, '..', 'data');

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'drivehunt-import/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(180_000),
        });
        const text = await res.text();
        if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        console.warn('  retrying:', e.message.split('\n')[0]);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw lastErr;
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const boundaryFile = path.join(DATA_DIR, 'boundary.geojson');
  let boundary;
  if (fs.existsSync(boundaryFile) && !REFRESH_BOUNDARY) {
    // Mirrors sometimes serve outdated/partial geometry; keep a known-good boundary.
    boundary = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
    console.log('Using existing boundary.geojson (pass --boundary to re-download)');
  } else {
    console.log(`Fetching boundary relation ${RELATION_ID} ...`);
    const boundaryOsm = await overpass(`[out:json][timeout:120];rel(${RELATION_ID});out body;>;out skel qt;`);
    const boundaryGeo = osmtogeojson(boundaryOsm);
    boundary = boundaryGeo.features.find((f) => f.id === `relation/${RELATION_ID}`);
    if (!boundary) throw new Error('Boundary polygon not found');
    boundary.properties = { name: boundary.properties.name, osm: boundary.id };
    fs.writeFileSync(boundaryFile, JSON.stringify(boundary));
  }
  console.log(`  boundary: ${boundary.properties.name}`);

  if (WITH_FIELDS) {
    console.log('Fetching fields ...');
    const lu = FIELD_LANDUSE.join('|');
    const fieldsOsm = await overpass(
      `[out:json][timeout:180];rel(${RELATION_ID});map_to_area->.a;` +
        `(way["landuse"~"^(${lu})$"](area.a);relation["landuse"~"^(${lu})$"](area.a););out body;>;out skel qt;`
    );
    const features = osmtogeojson(fieldsOsm)
      .features.filter((f) => /Polygon/.test(f.geometry.type) && FIELD_LANDUSE.includes(f.properties.landuse))
      .map((f) => ({
        type: 'Feature',
        id: f.id,
        properties: { id: f.id, landuse: f.properties.landuse, name: f.properties.name || null },
        geometry: f.geometry,
      }));
    fs.writeFileSync(path.join(DATA_DIR, 'fields.geojson'), JSON.stringify({ type: 'FeatureCollection', attribution: 'Felder &copy; OpenStreetMap-Mitwirkende (ODbL)', features }));
    console.log(`  ${features.length} fields written to data/fields.geojson`);
  }

  console.log('Fetching forest, scrub and water ...');
  const natureOsm = await overpass(
    `[out:json][timeout:180];rel(${RELATION_ID});map_to_area->.a;(` +
      `wr["landuse"~"^(forest|reservoir|basin)$"](area.a);wr["natural"~"^(wood|scrub|water)$"](area.a);` +
      `);out body;>;out skel qt;`
  );
  const kindOf = (t) =>
    t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin'
      ? 'water'
      : t.natural === 'scrub'
        ? 'scrub'
        : t.landuse === 'forest' || t.natural === 'wood'
          ? 'forest'
          : null;
  const asMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  const town = asMulti(boundary.geometry);
  const nature = [];
  for (const f of osmtogeojson(natureOsm).features) {
    const kind = kindOf(f.properties);
    if (!kind || !/Polygon/.test(f.geometry.type)) continue;
    // Only the part inside the town limits.
    const clipped = pc.intersection(asMulti(f.geometry), town);
    if (!clipped.length) continue;
    nature.push({
      type: 'Feature',
      id: f.id,
      properties: { id: f.id, landuse: kind, name: f.properties.name || null },
      geometry: clipped.length === 1 ? { type: 'Polygon', coordinates: clipped[0] } : { type: 'MultiPolygon', coordinates: clipped },
    });
  }
  // Water on top of forest: base features are drawn in file order.
  const order = { forest: 0, scrub: 1, water: 2 };
  nature.sort((a, b) => order[a.properties.landuse] - order[b.properties.landuse]);
  fs.writeFileSync(
    path.join(DATA_DIR, 'nature.geojson'),
    JSON.stringify({ type: 'FeatureCollection', attribution: 'Wald/Gewässer &copy; OpenStreetMap-Mitwirkende (ODbL)', features: nature })
  );
  const counts = {};
  for (const f of nature) counts[f.properties.landuse] = (counts[f.properties.landuse] || 0) + 1;
  console.log('  nature.geojson:', counts);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
