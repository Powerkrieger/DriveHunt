'use strict';

const FIELD_GREEN = '#43a047';
// Colour and default fill opacity per area type.
const TYPE_STYLE = {
  forest: ['#1b5e20', 0.5], // darker green
  scrub: ['#7c8a1e', 0.45], // olive
  water: ['#1e88e5', 0.5], // blue
};
const typeStyle = (landuse) => TYPE_STYLE[landuse] || [FIELD_GREEN, 0.3];
const BOUNDARY_ORANGE = '#ff8c00';
const PALETTE = ['#e53935', '#1e88e5', '#8e24aa', '#fdd835', '#00897b', '#f4511e', '#3949ab', '#c0ca33', '#6d4c41', '#d81b60'];
const LANDUSE_DE = {
  farmland: 'Acker', meadow: 'Grünland', grass: 'Grünland', grassland: 'Grünland',
  forest: 'Wald', scrub: 'Gebüsch', water: 'Gewässer', other: 'Sonstige Fläche', custom: 'Eigene Fläche',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  me: null,
  hunts: [],
  fieldLayers: new Map(), // id -> L.Polygon
  fieldGeom: new Map(), // id -> GeoJSON geometry
  view: 'list', // list | focus | edit | fields
  focusId: null,
  draft: null,
  sim: null,
};

let map, layersControl, fieldsGroup, boundaryLayer, overlayLayer, simLayer, setupLayer, arrowEditLayer;
let baseLayers = null; // { osm, dop, esri } — current base tile layers
let exportOpts = null; // when set, the main map is an A4-export preview (see export.js)

// Switch the visible base map (used by the settings default + live switching).
function setBaseMap(key) {
  if (!baseLayers) return;
  const next = baseLayers[key] || baseLayers.osm;
  for (const l of Object.values(baseLayers)) if (l !== next && map.hasLayer(l)) map.removeLayer(l);
  if (!map.hasLayer(next)) next.addTo(map);
}

// ---------------------------------------------------------------- API

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Session expired while the app was open -> back to the login screen.
  if (res.status === 401 && state.me) {
    location.reload();
    throw new Error('Nicht angemeldet');
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- boot / login

async function boot() {
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    $('login').classList.remove('hidden');
    return;
  }
  start();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    state.me = await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
    $('login').classList.add('hidden');
    start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('set-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.reload();
});

async function start() {
  $('app').classList.remove('hidden');
  document.body.classList.toggle('is-editor', state.me.role === 'editor');
  $('whoami').textContent = state.me.username;

  const [geo, hunts] = await Promise.all([api('GET', '/api/geo'), api('GET', '/api/hunts')]);
  state.hunts = hunts;
  initMap(geo);
  render();

  const es = new EventSource('/api/events');
  es.addEventListener('hunts', reloadHunts);
  es.addEventListener('fields', () => reloadFields());
  es.addEventListener('markers', () => window.Markers?.reload());
  es.addEventListener('todos', () => window.Todos?.reload());
  window.Markers?.init();
  window.Todos?.init();
  window.Settings?.applySimDefaults();
  window.Settings?.init();
}

async function reloadFields() {
  const geo = await api('GET', '/api/geo');
  setFields(geo.fields);
  window.FieldEdit?.onFieldsReloaded();
  render();
}

async function reloadHunts() {
  state.hunts = await api('GET', '/api/hunts');
  if (state.view === 'edit') return state.draft && renderList(); // don't disturb the draft on the map
  if (state.view === 'focus' && !huntById(state.focusId)) return showList();
  if (state.view === 'focus') return showFocus(state.focusId, false);
  render();
}

// ---------------------------------------------------------------- map

// Base tile layer factory — each map (main + A4 print map) needs its own
// instance, so this is the single source of the three base maps.
function createBaseLayer(key) {
  // crossOrigin: request tiles with CORS (all three servers send the headers) so
  // the service worker stores non-opaque responses. Opaque (no-cors) responses
  // are padded to ~7 MB each in the browser's storage accounting, which made the
  // offline cache look like tens of GB and could blow the storage quota.
  if (key === 'dop')
    return L.tileLayer.wms('https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD', {
      layers: 'sh_dop20_rgb', format: 'image/jpeg', maxZoom: 20, crossOrigin: true,
      attribution: 'Luftbild &copy; GeoBasis-DE/LVermGeo SH (CC BY 4.0)',
    });
  if (key === 'esri')
    return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, crossOrigin: true, attribution: 'Tiles &copy; Esri',
    });
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: true, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
}
// Which base map is currently shown on the main map.
function activeBaseMapKey() {
  for (const k of ['osm', 'dop', 'esri']) if (baseLayers && map.hasLayer(baseLayers[k])) return k;
  return 'osm';
}

// Base maps offered in the toolbar's 🗺️ panel.
const BASE_MAPS = [['osm', 'OpenStreetMap'], ['dop', 'Luftbild SH (DOP20)'], ['esri', 'Luftbild Esri']];

function renderLayerList(box) {
  const list = document.createElement('div');
  list.className = 'tb-layerlist';
  const sync = () => {
    const cur = activeBaseMapKey();
    list.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.base === cur;
      b.classList.toggle('active', on);
      b.querySelector('.chk').textContent = on ? '✓' : '';
    });
  };
  for (const [k, name] of BASE_MAPS) {
    const b = document.createElement('button');
    b.dataset.base = k;
    b.innerHTML = `<span class="chk"></span>${name}`;
    b.addEventListener('click', () => { setBaseMap(k); sync(); });
    list.appendChild(b);
  }
  box.appendChild(list);
  sync();
}

// ---- toolbar extension: the layer chooser and the measure readout slide down
// as part of the bar (not floating popups). Only one shows at a time; 'layers'
// is a transient panel the user toggles, 'measure' stays while that tool runs.
const Ext = {
  layersOpen: false,
  render() {
    const box = $('tb-ext');
    const want = Ext.layersOpen ? 'layers' : (window.Measure?.active ? 'measure' : null);
    if (want) {
      box.innerHTML = '';
      const inner = document.createElement('div');
      inner.className = 'tb-ext-inner';
      box.appendChild(inner); // in the DOM before content renders (measure checks isConnected)
      if (want === 'layers') renderLayerList(inner);
      else window.Measure.mount(inner);
      box.classList.add('open');
    } else {
      box.classList.remove('open');
      setTimeout(() => { if (!box.classList.contains('open')) box.innerHTML = ''; }, 240);
    }
    $('tb-layers').classList.toggle('ext-active', Ext.layersOpen);
  },
  toggleLayers() { Ext.layersOpen = !Ext.layersOpen; Ext.render(); },
  closeLayers() { if (Ext.layersOpen) { Ext.layersOpen = false; Ext.render(); } },
};
window.Ext = Ext;

// ---- tool coordinator: one map interaction at a time. While a multi-step
// action is in progress (the ✓/✕ action bar is up — drawing, moving a marker,
// editing a field) other tools are blocked so the work isn't lost; harmless
// controls (layers, GPS, zoom) stay available.
const Tools = {
  busy: () => !!window.ActionBar?.visible,
  nudge() {
    const b = $('action-bar');
    if (!b || b.classList.contains('hidden')) return;
    b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge');
  },
};
window.Tools = Tools;

// ---- map lock: freeze all map-feature interaction (field taps, marker popups,
// long-press add) so the map can be panned and zoomed freely without triggering
// anything — e.g. holding the phone in the field. Pan + zoom keep working.
// Starting any drawing / editing tool releases the lock so the toolbar stays
// usable; locking is blocked while an action is in progress (nudge).
const Lock = {
  active: false,
  toggle() {
    if (!Lock.active && Tools.busy()) return Tools.nudge();
    Lock.active ? Lock.release() : Lock.engage();
  },
  engage() {
    window.Measure?.stop?.();
    window.Markers?.stop?.();
    Ext.closeLayers();
    Lock.active = true;
    Lock.sync();
  },
  release() {
    if (!Lock.active) return;
    Lock.active = false;
    Lock.sync();
  },
  sync() {
    document.body.classList.toggle('map-locked', Lock.active);
    const btn = $('tb-lock');
    btn.classList.toggle('active', Lock.active);
    btn.querySelector('.tb-ic').textContent = Lock.active ? '🔒' : '🔓';
    btn.title = Lock.active ? 'Karte entsperren' : 'Karte sperren – nur verschieben und zoomen';
    btn.setAttribute('aria-pressed', String(Lock.active));
  },
};
window.Lock = Lock;

// Keep the toolbar compass in sync with the map's rotation: it hides at due
// north and otherwise shows, with its needle pointing to geographic north.
function syncCompass() {
  const btn = $('tb-compass');
  if (!btn || !map?.getBearing) return;
  const b = map.getBearing() || 0;
  const north = ((Math.round(b) % 360) + 360) % 360 === 0;
  btn.classList.toggle('hidden', north);
  btn.querySelector('.compass-ic').style.transform = `rotate(${-b}deg)`;
}

function initMap(geo) {
  // rotate: two-finger twist on touch, Shift+drag on desktop; the compass button
  // resets to north. zoomAnimation is OFF on purpose — the plugin's animated zoom
  // fights the rotated pane (it reset the bearing and made the SVG field overlays
  // jump/misalign during zoom). The instant path keeps overlays glued to the map
  // through both zoom and turn.
  map = L.map('map', {
    zoomControl: false,
    rotate: true,
    touchRotate: true,
    shiftKeyRotate: true,
    rotateControl: false,
    zoomAnimation: false,
    bearing: 0,
  });
  map.on('rotate', syncCompass);

  const osm = createBaseLayer('osm'), dop = createBaseLayer('dop'), esri = createBaseLayer('esri');
  baseLayers = { osm, dop, esri };
  setBaseMap(window.Settings?.defaultBaseMap?.() || 'osm');
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  map.on('click', () => Ext.closeLayers()); // tapping the map closes the layer panel

  // Town limits: orange, not interactive.
  boundaryLayer = L.geoJSON(geo.boundary, {
    interactive: false,
    style: { color: BOUNDARY_ORANGE, weight: 3, fillColor: BOUNDARY_ORANGE, fillOpacity: 0.12 },
  }).addTo(map);

  fieldsGroup = L.featureGroup().addTo(map);
  setFields(geo.fields);
  if (geo.fields.attribution) map.attributionControl.addAttribution(geo.fields.attribution);

  overlayLayer = L.layerGroup().addTo(map);
  simLayer = L.layerGroup().addTo(map);
  arrowEditLayer = L.layerGroup().addTo(map);
  setupLayer = L.layerGroup().addTo(map);
  map.fitBounds(boundaryLayer.getBounds());
}

function setFields(fc) {
  fieldsGroup.clearLayers();
  state.fieldLayers.clear();
  state.fieldGeom.clear();
  L.geoJSON(fc, {
    onEachFeature: (feature, layer) => {
      const id = feature.properties.id;
      state.fieldLayers.set(id, layer);
      state.fieldGeom.set(id, feature.geometry);
      layer.feature = feature;
      layer.on('click', () => onFieldClick(id));
      layer.bindTooltip(() => fieldTooltip(feature), { sticky: true });
      fieldsGroup.addLayer(layer);
    },
  });
  // Keep fields below arrows / simulation, boundary below everything.
  fieldsGroup.bringToBack();
  boundaryLayer.bringToBack();
}

function fieldTooltip(feature) {
  const p = feature.properties;
  const hunts = state.hunts.filter((h) => h.field_ids.includes(p.id));
  const kind = LANDUSE_DE[p.landuse] || p.landuse;
  return (
    `${p.name ? `<b>${esc(p.name)}</b> · ${kind}` : kind} · ${Math.round(areaHa(feature.geometry) * 10) / 10} ha` +
    (p.flik ? `<br><small>${esc(p.flik)}</small>` : '') +
    hunts.map((h) => `<br>Treiben ${h.seq}: ${esc(h.name)}`).join('')
  );
}

const huntById = (id) => state.hunts.find((h) => h.id === id);

// Geometry helpers (local metric projection, good enough at village scale).
function projectedRings(geometry) {
  const rings = DriveSim.ringsOf(geometry);
  const [lat0, lng0] = rings[0][0];
  const proj = DriveSim.makeProjection(lat0, lng0);
  return { proj, rings: rings.map((r) => r.map(proj.toXY)) };
}
function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}
function areaHa(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      const { rings } = projectedRings({ type: 'Polygon', coordinates: [ring] });
      total += (i === 0 ? 1 : -1) * Math.abs(ringArea(rings[0]));
    });
  }
  return total / 10000;
}
function centroidOf(geometry) {
  const { proj, rings } = projectedRings(geometry);
  const r = rings.reduce((best, x) => (Math.abs(ringArea(x)) > Math.abs(ringArea(best)) ? x : best));
  let cx = 0, cy = 0;
  const a = ringArea(r);
  for (let i = 0; i < r.length - 1; i++) {
    const f = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    cx += (r[i][0] + r[i + 1][0]) * f;
    cy += (r[i][1] + r[i + 1][1]) * f;
  }
  return proj.toLatLng([cx / (6 * a), cy / (6 * a)]);
}
// Label goes on the largest field of the group.
function labelPosition(fieldIds) {
  const geoms = fieldIds.map((id) => state.fieldGeom.get(id)).filter(Boolean);
  if (!geoms.length) return null;
  return centroidOf(geoms.reduce((best, g) => (areaHa(g) > areaHa(best) ? g : best)));
}

// Direction path with an arrow head on the last segment. `arrow` = [[lat,lng], ...] (2+ points).
function arrowLayers(arrow, color) {
  const proj = DriveSim.makeProjection(arrow[0][0], arrow[0][1]);
  const pts = arrow.map(proj.toXY);
  const b = pts[pts.length - 1], a = pts[pts.length - 2];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1) return [];
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  const head = Math.min(80, Math.max(15, len * 0.4)), w = head * 0.55;
  const base = [b[0] - ux * head, b[1] - uy * head];
  const tri = [b, [base[0] - uy * w, base[1] + ux * w], [base[0] + uy * w, base[1] - ux * w]].map(proj.toLatLng);
  const shaft = [...arrow.slice(0, -1), proj.toLatLng(base)];
  const opts = { color: '#fff', weight: 9, opacity: 0.8, interactive: false, lineJoin: 'round' };
  return [
    L.polyline(shaft, opts),
    L.polyline(shaft, { ...opts, color, weight: 5, opacity: 1 }),
    L.polygon(tri, { color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }),
  ];
}

function labelMarker(pos, text, color) {
  return L.marker(pos, {
    interactive: false,
    icon: L.divIcon({ className: 'hunt-label', html: `<span class="badge" style="background:${color}">${esc(text)}</span>`, iconSize: [0, 0] }),
  });
}

// ---------------------------------------------------------------- rendering

function render() {
  if (exportOpts) return renderExportPreview();
  renderFields();
  renderOverlays();
  renderList();
}

// ---- A4 export live preview --------------------------------------------------
// While the export frame is up, the main map is a WYSIWYG preview driven by the
// export options, so what you frame is what the PDF shows. export.js sets the
// options via setExportMode(); print uses the same options.
function setExportMode(opts) {
  exportOpts = opts;
  if (opts) {
    map?.setBearing?.(0); // the A4 viewfinder frame is axis-aligned; export north-up
    render();
  }
}

// Driver chain + driver/stander dots at the start of the drive (the simulation's
// initial positions). Shared by the preview and the print map. [] if not drivable.
function setupPreviewLayers(h) {
  if (!h.arrow) return [];
  const geoms = h.field_ids.map((id) => state.fieldGeom.get(id)).filter(Boolean);
  if (!geoms.length) return [];
  const s0 = DriveSim.createSimulation(h.arrow, geoms, simParams(), h.setup).stateAt(0);
  const layers = [
    L.polyline(s0.drivers.map((d) => d.pos), { color: '#ff9800', weight: 2, dashArray: '6 6', interactive: false }),
    L.polyline(s0.standers.map((d) => d.pos), { color: '#1565c0', weight: 2, dashArray: '6 6', interactive: false }),
  ];
  for (const d of s0.drivers)
    layers.push(L.circleMarker(d.pos, { radius: 5, color: '#fff', weight: 2, fillColor: d.flank ? '#e91e63' : '#ff9800', fillOpacity: 1, interactive: false }));
  for (const d of s0.standers)
    layers.push(L.circleMarker(d.pos, { radius: 6, color: '#fff', weight: 2, fillColor: '#1565c0', fillOpacity: 1, interactive: false }));
  return layers;
}

function renderExportPreview() {
  const opts = exportOpts;
  const focus = huntById(state.focusId);
  const hunts = opts.all ? state.hunts : [focus].filter(Boolean);
  const firstHunt = new Map();
  if (opts.all) for (const h of state.hunts) for (const id of h.field_ids) if (!firstHunt.has(id)) firstHunt.set(id, h);

  for (const [id, layer] of state.fieldLayers) {
    const [base, bo] = typeStyle(layer.feature.properties.landuse);
    let style;
    if (opts.all) {
      const h = firstHunt.get(id);
      style = h
        ? { color: h.color, weight: 2, fillColor: h.color, fillOpacity: 0.5, dashArray: null }
        : { color: base, weight: 1, fillColor: base, fillOpacity: bo, dashArray: null };
    } else {
      style = focus && focus.field_ids.includes(id)
        ? { color: '#000', weight: 2, fillColor: focus.color, fillOpacity: 0.45, dashArray: null }
        : { color: base, weight: 1, fillColor: base, fillOpacity: bo * 0.5, dashArray: null };
    }
    layer.setStyle(style);
  }

  overlayLayer.clearLayers();
  arrowEditLayer.clearLayers();
  setupLayer.clearLayers();
  simLayer.clearLayers();
  for (const h of hunts) {
    if (h.arrow) arrowLayers(h.arrow, h.color).forEach((l) => l.addTo(overlayLayer));
    if (opts.numbers) {
      const pos = labelPosition(h.field_ids);
      if (pos) labelMarker(pos, h.seq, h.color).addTo(overlayLayer);
    }
    if (opts.setup) setupPreviewLayers(h).forEach((l) => l.addTo(simLayer));
  }
}

function renderFields() {
  const firstHunt = new Map();
  for (const h of state.hunts) for (const id of h.field_ids) if (!firstHunt.has(id)) firstHunt.set(id, h);
  const focus = state.view === 'focus' ? huntById(state.focusId) : null;
  const draftIds = state.view === 'edit' ? new Set(state.draft.field_ids) : null;
  const selected = state.view === 'fields' ? window.FieldEdit.selected : null;

  for (const [id, layer] of state.fieldLayers) {
    const [base, baseOpacity] = typeStyle(layer.feature.properties.landuse);
    let style;
    if (selected?.has(id)) {
      style = { color: '#ffeb3b', weight: 4, fillColor: '#ffeb3b', fillOpacity: 0.35, dashArray: null };
    } else if (draftIds) {
      style = draftIds.has(id)
        ? { color: '#000', weight: 3, fillColor: state.draft.color, fillOpacity: 0.6, dashArray: null }
        : { color: base, weight: 1, fillColor: base, fillOpacity: baseOpacity * 0.8, dashArray: '4 4' };
    } else if (focus) {
      style = focus.field_ids.includes(id)
        ? { color: '#000', weight: 2, fillColor: focus.color, fillOpacity: 0.45, dashArray: null }
        : { color: base, weight: 1, fillColor: base, fillOpacity: baseOpacity * 0.4, dashArray: null };
    } else {
      const h = firstHunt.get(id);
      style = h
        ? { color: h.color, weight: 2, fillColor: h.color, fillOpacity: 0.5, dashArray: null }
        : { color: base, weight: 1, fillColor: base, fillOpacity: baseOpacity, dashArray: null };
    }
    layer.setStyle(style);
  }
}

function renderOverlays() {
  overlayLayer.clearLayers();
  let hunts;
  if (state.view === 'fields') hunts = [];
  else if (state.view === 'edit') hunts = [state.draft];
  else if (state.view === 'focus') hunts = [huntById(state.focusId)].filter(Boolean);
  else hunts = state.hunts;

  for (const h of hunts) {
    if (h.arrow && state.view !== 'edit') arrowLayers(h.arrow, h.color).forEach((l) => l.addTo(overlayLayer));
    const pos = labelPosition(h.field_ids);
    if (pos) labelMarker(pos, h.seq, h.color).addTo(overlayLayer);
  }
  renderEditArrow();
  renderSetup();
}

// The arrow of the drive being edited, with draggable points
// (right-click / long press on a middle point removes it).
function renderEditArrow() {
  arrowEditLayer.clearLayers();
  const arrow = state.view === 'edit' && !window.Sketch?.active && state.draft.arrow;
  if (!arrow) return;
  const shaft = L.layerGroup().addTo(arrowEditLayer);
  const drawShaft = () => {
    shaft.clearLayers();
    arrowLayers(arrow, state.draft.color).forEach((l) => l.addTo(shaft));
  };
  drawShaft();
  arrow.forEach((pt, i) => {
    Sketch.handle(pt, {
      onMove: (ll) => {
        arrow[i] = [ll.lat, ll.lng];
        drawShaft();
      },
      onRemove: arrow.length > 2 ? () => (arrow.splice(i, 1), renderEditArrow()) : null,
    }).addTo(arrowEditLayer);
  });
}

// Start positions (Aufstellung) of the drive being edited: draggable markers.
// Drag to move, right-click / long press to remove.
function renderSetup() {
  setupLayer.clearLayers();
  const setup = state.view === 'edit' && state.draft.setup;
  updateSetupInfo();
  if (!setup) return;
  for (const kind of ['drivers', 'standers']) {
    setup[kind].forEach((pos, i) => {
      const m = L.marker(pos, {
        draggable: true,
        icon: L.divIcon({ className: `setup-marker ${kind}`, iconSize: [16, 16] }),
        title: kind === 'drivers' ? `Treiber ${i + 1}` : `Schütze ${i + 1}`,
      });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        setup[kind][i] = [ll.lat, ll.lng];
      });
      m.on('contextmenu', () => {
        setup[kind].splice(i, 1);
        renderSetup();
      });
      m.addTo(setupLayer);
    });
  }
}

function updateSetupInfo() {
  const setup = state.view === 'edit' && state.draft.setup;
  $('setup-info').textContent = setup
    ? `${setup.drivers.length} Treiber, ${setup.standers.length} Schützen aufgestellt. Punkte ziehen zum Verschieben, Rechtsklick / lange drücken zum Entfernen.`
    : 'Keine Aufstellung – die Simulation stellt automatisch auf.';
  $('setup-clear').disabled = !setup;
}

function renderList() {
  const ol = $('hunt-list');
  if (!state.hunts.length) {
    ol.innerHTML = '<li class="empty">Noch keine Treiben angelegt.</li>';
    return;
  }
  ol.innerHTML = state.hunts
    .map(
      (h) => `<li data-id="${h.id}">
        <span class="badge" style="background:${h.color}">${h.seq}</span>
        <span class="meta">${esc(h.name)}<small>${h.field_ids.length} Felder · ${totalHa(h).toFixed(1)} ha${h.arrow ? '' : ' · kein Pfeil'}</small></span>
      </li>`
    )
    .join('');
  ol.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => showFocus(Number(li.dataset.id))));
}

const totalHa = (h) => h.field_ids.reduce((s, id) => s + (state.fieldGeom.has(id) ? areaHa(state.fieldGeom.get(id)) : 0), 0);

function setView(view) {
  state.view = view;
  for (const v of ['list', 'focus', 'edit', 'fields']) $(`${v}-view`).classList.toggle('hidden', v !== view);
}

// The Treiben panel is opened on demand from the 📋 button; it slides in from
// the right (bottom sheet on phones). Any view that needs it opens it.
function openPanel() {
  $('panel').classList.add('open');
  $('treiben-open').classList.add('active');
}
function closePanel() {
  $('panel').classList.remove('open');
  $('treiben-open').classList.remove('active');
}

function fitFields(fieldIds) {
  const layers = fieldIds.map((id) => state.fieldLayers.get(id)).filter(Boolean);
  if (!layers.length) return;
  const wide = window.innerWidth > 700;
  map.fitBounds(L.featureGroup(layers).getBounds(), {
    paddingTopLeft: [40, 40],
    paddingBottomRight: wide ? [380, 40] : [40, window.innerHeight * 0.55],
    maxZoom: 17,
  });
}

// ---------------------------------------------------------------- views

function showList() {
  stopSim();
  state.focusId = null;
  openPanel();
  setView('list');
  render();
}

function showFocus(id, fit = true) {
  const h = huntById(id);
  if (!h) return showList();
  const keepSim = state.focusId === id && state.sim;
  state.focusId = id;
  openPanel();
  setView('focus');
  render();
  $('focus-title').innerHTML = `<span class="badge" style="background:${h.color}">${h.seq}</span> ${esc(h.name)}`;
  $('focus-notes').textContent = h.notes;
  $('focus-info').textContent = `${h.field_ids.length} Felder · ${totalHa(h).toFixed(1)} ha`;
  $('sim-missing').classList.toggle('hidden', !!h.arrow && h.field_ids.length > 0);
  $('sim-controls').classList.toggle('hidden', !h.arrow || !h.field_ids.length);
  // With a fixed setup, counts and flank lead come from the placed hunters.
  $('sim-auto-params').classList.toggle('hidden', !!h.setup);
  $('sim-setup-info').classList.toggle('hidden', !h.setup);
  if (h.setup) $('sim-setup-info').textContent = `Aufstellung festgelegt: ${h.setup.drivers.length} Treiber, ${h.setup.standers.length} Schützen.`;
  if (!keepSim) stopSim();
  buildSim();
  if (fit) fitFields(h.field_ids);
}

$('focus-back').addEventListener('click', showList);
$('panel-close').addEventListener('click', closePanel);
// 📋 opens the Treiben list; if the panel was left on another view, show the list.
$('treiben-open').addEventListener('click', () => {
  if ($('panel').classList.contains('open')) return closePanel();
  if (Tools.busy()) return Tools.nudge();
  window.Measure?.stop?.();
  Ext.closeLayers();
  openPanel();
  if (state.view !== 'list') showList();
});

// Zoom + layer chooser (harmless, available any time).
$('tb-zoomin').addEventListener('click', () => map?.zoomIn());
$('tb-zoomout').addEventListener('click', () => map?.zoomOut());
$('tb-layers').addEventListener('click', () => Ext.toggleLayers());
$('tb-lock').addEventListener('click', () => Lock.toggle());
$('tb-compass').addEventListener('click', () => map?.setBearing?.(0));

// ---------------------------------------------------------------- editing

$('new-hunt').addEventListener('click', () => {
  const seq = state.hunts.reduce((m, h) => Math.max(m, h.seq), 0) + 1;
  startEdit({ id: null, seq, name: `Treiben ${seq}`, color: PALETTE[(seq - 1) % PALETTE.length], field_ids: [], arrow: null, setup: null, notes: '' });
});
$('focus-edit').addEventListener('click', () => startEdit(structuredClone(huntById(state.focusId))));
$('focus-delete').addEventListener('click', async () => {
  const h = huntById(state.focusId);
  if (!confirm(`Treiben ${h.seq} „${h.name}" wirklich löschen?`)) return;
  await api('DELETE', `/api/hunts/${h.id}`);
  state.hunts = state.hunts.filter((x) => x.id !== h.id);
  showList();
});

function startEdit(draft) {
  window.Lock?.release(); // editing needs field taps
  stopSim();
  state.draft = draft;
  openPanel();
  setView('edit');
  $('edit-title').textContent = draft.id ? 'Treiben bearbeiten' : 'Neues Treiben';
  $('edit-seq').value = draft.seq;
  $('edit-name').value = draft.name;
  $('edit-color').value = draft.color;
  $('edit-notes').value = draft.notes;
  $('edit-error').textContent = '';
  if (draft.setup) {
    $('setup-ndrivers').value = draft.setup.drivers.length;
    $('setup-nstanders').value = draft.setup.standers.length;
  }
  updateEditInfo();
  render();
}

function updateEditInfo() {
  $('edit-count').textContent = state.draft.field_ids.length;
  $('edit-arrow').textContent = state.draft.arrow ? 'Pfeil neu zeichnen' : 'Pfeil zeichnen';
}

for (const [el, key, conv] of [
  ['edit-seq', 'seq', Number],
  ['edit-name', 'name', String],
  ['edit-color', 'color', String],
  ['edit-notes', 'notes', String],
]) {
  $(el).addEventListener('input', (e) => {
    state.draft[key] = conv(e.target.value);
    if (key === 'color' || key === 'seq') {
      renderFields();
      renderOverlays();
    }
  });
}

const SKETCH_TEXT = {
  arrow: [
    'Tippe auf den <b>Startpunkt</b> (wo die Treiber beginnen).',
    'Weitere Punkte an den <b>Kurven</b> antippen, zuletzt den <b>Endpunkt</b> (wo die Schützen stehen).',
  ],
  drivers: ['Grobe <b>Treiberlinie</b> zeichnen: Punkte von links nach rechts antippen.', 'Die Treiber werden gleichmäßig entlang der Linie verteilt.'],
  standers: ['<b>Schützenlinie</b> zeichnen: Punkte antippen.', 'Die Schützen werden gleichmäßig entlang der Linie verteilt.'],
};

$('edit-arrow').addEventListener('click', () => {
  Sketch.start({
    kind: 'line', arrow: true, color: state.draft.color, min: 2, texts: SKETCH_TEXT.arrow,
    onDone: (points) => {
      state.draft.arrow = points;
      updateEditInfo();
      renderOverlays();
    },
    onCancel: renderOverlays,
  });
  renderEditArrow(); // hide the old arrow's handles while drawing
});
$('edit-arrow-clear').addEventListener('click', () => {
  Sketch.cancel(true);
  state.draft.arrow = null;
  updateEditInfo();
  renderOverlays();
});

// Rough hunters' line drawn by the hunt leader: spread the hunters evenly along it.
function sketchSetupLine(kind) {
  const n = setupCount(kind);
  Sketch.start({
    kind: 'line', color: kind === 'drivers' ? '#ff9800' : '#1565c0', min: n > 1 ? 2 : 1, texts: SKETCH_TEXT[kind],
    onDone: (points) => {
      state.draft.setup ||= { drivers: [], standers: [] };
      state.draft.setup[kind] = DriveSim.distributeAlong(points, n);
      renderOverlays();
    },
  });
}

// ---- setup (Aufstellung)

function setupCount(kind) {
  const el = $(kind === 'drivers' ? 'setup-ndrivers' : 'setup-nstanders');
  const n = Math.round(+el.value);
  return Number.isFinite(n) ? Math.max(kind === 'drivers' ? 1 : 0, Math.min(kind === 'drivers' ? 100 : 50, n)) : 0;
}

$('setup-auto').addEventListener('click', () => {
  const d = state.draft;
  const geoms = d.field_ids.map((id) => state.fieldGeom.get(id)).filter(Boolean);
  if (!d.arrow || !geoms.length) {
    $('edit-error').textContent = 'Für die automatische Aufstellung zuerst Felder wählen und den Pfeil zeichnen.';
    return;
  }
  $('edit-error').textContent = '';
  const sim = DriveSim.createSimulation(d.arrow, geoms, { ...simParams(), drivers: setupCount('drivers'), standers: setupCount('standers') });
  const start = sim.stateAt(0);
  d.setup = { drivers: start.drivers.map((x) => x.pos), standers: start.standers.map((x) => x.pos) };
  renderSetup();
});
$('setup-draw-drivers').addEventListener('click', () => sketchSetupLine('drivers'));
$('setup-draw-standers').addEventListener('click', () => sketchSetupLine('standers'));
$('setup-clear').addEventListener('click', () => {
  state.draft.setup = null;
  renderSetup();
});

function onFieldClick(id) {
  if (window.Lock?.active) return; // map locked: only pan / zoom
  if (exportOpts) return; // frozen as an export preview
  if (window.Measure?.active || window.Sketch?.active || window.Markers?.placing) return; // taps belong to the tool
  if (state.view === 'fields') return window.FieldEdit.onFieldClick(id);
  if (state.view === 'edit') {
    const ids = state.draft.field_ids;
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
    else ids.push(id);
    updateEditInfo();
    renderFields();
    renderOverlays();
    return;
  }
  // Viewing: clicking a field of a hunt focuses that hunt.
  const h = state.hunts.find((x) => x.field_ids.includes(id));
  if (h && h.id !== state.focusId) showFocus(h.id);
}

$('edit-cancel').addEventListener('click', () => {
  const id = state.draft.id;
  Sketch.cancel(true);
  state.draft = null;
  id ? showFocus(id, false) : showList();
});

$('edit-save').addEventListener('click', async () => {
  const d = state.draft;
  const setup = d.setup && (d.setup.drivers.length || d.setup.standers.length) ? d.setup : null;
  const body = { seq: d.seq, name: d.name, color: d.color, field_ids: d.field_ids, arrow: d.arrow, setup, notes: d.notes };
  try {
    const saved = d.id ? await api('PUT', `/api/hunts/${d.id}`, body) : await api('POST', '/api/hunts', body);
    Sketch.cancel(true);
    state.draft = null;
    state.hunts = await api('GET', '/api/hunts');
    showFocus(saved.id, false);
  } catch (err) {
    $('edit-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- simulation

function simParams() {
  const num = (id, def) => (Number.isFinite(+$(id).value) && $(id).value !== '' ? +$(id).value : def);
  return {
    drivers: Math.max(1, Math.round(num('sim-drivers', 12))),
    standers: Math.max(0, Math.round(num('sim-standers', 4))),
    speed: Math.max(0.5, num('sim-speed', 3)) / 3.6,
    maxSpeed: Math.max(num('sim-speed', 3), num('sim-maxspeed', 5)) / 3.6,
    standerSpeed: Math.max(0.5, num('sim-standerspeed', 1.5)) / 3.6,
    flank: Math.max(0, num('sim-flank', 40)),
  };
}

function buildSim() {
  const h = huntById(state.focusId);
  if (state.sim) cancelAnimationFrame(state.sim.raf);
  simLayer.clearLayers();
  if (!h || !h.arrow || !h.field_ids.length) return (state.sim = null);
  const geoms = h.field_ids.map((id) => state.fieldGeom.get(id)).filter(Boolean);
  const sim = DriveSim.createSimulation(h.arrow, geoms, simParams(), h.setup);
  const frac = state.sim && state.sim.model.duration ? state.sim.time / state.sim.model.duration : 0;

  const mk = (color, r) => L.circleMarker([0, 0], { radius: r, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false });
  const s0 = sim.stateAt(0);
  // Estimated duration: until the slowest person has arrived.
  const sl = sim.stats.slowest;
  const who = sl.kind === 'driver' ? `Treiber ${sl.n}` : `Schütze ${sl.n}`;
  $('sim-duration').innerHTML =
    `<b>Dauer ≈ ${Math.round(sim.duration / 60)} min</b> – so lange braucht die langsamste Person (${who}, ` +
    `${(sl.distance / 1000).toFixed(2).replace('.', ',')} km Weg).`;
  const view = {
    tracks: L.layerGroup().addTo(simLayer),
    driverLine: L.polyline([], { color: '#ff9800', weight: 2, dashArray: '6 6', interactive: false }).addTo(simLayer),
    standerLine: L.polyline([], { color: '#1565c0', weight: 2, dashArray: '6 6', interactive: false }).addTo(simLayer),
    drivers: s0.drivers.map((d) => mk(d.flank ? '#e91e63' : '#ff9800', 6).addTo(simLayer)),
    standers: s0.standers.map(() => mk('#1565c0', 7).addTo(simLayer)),
  };
  state.sim = { model: sim, view, time: frac * sim.duration, playing: state.sim?.playing || false, last: null, raf: null };
  drawSim();
  if (state.sim.playing) state.sim.raf = requestAnimationFrame(tick);
}

function drawSim() {
  const { model, view, time } = state.sim;
  const s = model.stateAt(time);
  view.tracks.clearLayers();
  if ($('sim-tracks').checked) {
    const n = s.drivers.length + s.standers.length;
    for (let i = 0; i < n; i++) {
      const color = i < s.drivers.length ? (s.drivers[i].flank ? '#e91e63' : '#ff9800') : '#1565c0';
      L.polyline(model.trackUntil(i, time), { color, weight: 2, opacity: 0.7, interactive: false }).addTo(view.tracks);
    }
  }
  s.drivers.forEach((d, i) => view.drivers[i].setLatLng(d.pos));
  s.standers.forEach((d, i) => view.standers[i].setLatLng(d.pos));
  view.driverLine.setLatLngs(s.drivers.map((d) => d.pos));
  view.standerLine.setLatLngs(s.standers.map((d) => d.pos));

  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const phase = {
    approach: `Treiber rücken vor · Schützen warten (ab ${model.params.meetDistance} m gehen sie entgegen)`,
    gather: 'Treiber sammeln sich an der Feldgrenze',
    mark: `${model.params.meetDistance}-m-Marke: Treiber richten die Linie aus, dann gehen die Schützen los`,
    reposition: 'Treiber stellen sich im nächsten Feld neu auf',
    closing: 'Beide Linien gehen aufeinander zu',
    catchup: 'Nachzügler schließen auf',
    done: 'Linien haben sich getroffen – Treiben beendet',
  }[s.phase];
  const stage = s.stages > 1 ? ` · Feld ${s.stage}/${s.stages}` : '';
  $('sim-status').innerHTML = `${fmt(s.time)} / ${fmt(model.duration)} min · Abstand ${Math.round(s.gap)} m${stage}<br>${phase}`;
  $('sim-scrub').value = model.duration ? Math.round((time / model.duration) * 1000) : 0;
  $('sim-play').textContent = state.sim.playing ? '⏸ Pause' : time >= model.duration ? '↺ Neu' : '▶ Start';
}

function tick(now) {
  const sim = state.sim;
  if (!sim || !sim.playing) return;
  if (sim.last != null) sim.time += ((now - sim.last) / 1000) * Number($('sim-rate').value);
  sim.last = now;
  if (sim.time >= sim.model.duration) {
    sim.time = sim.model.duration;
    sim.playing = false;
  }
  drawSim();
  if (sim.playing) sim.raf = requestAnimationFrame(tick);
}

function stopSim() {
  if (state.sim) cancelAnimationFrame(state.sim.raf);
  state.sim = null;
  simLayer?.clearLayers();
}

$('sim-play').addEventListener('click', () => {
  const sim = state.sim;
  if (!sim) return;
  if (sim.time >= sim.model.duration) sim.time = 0;
  sim.playing = !sim.playing;
  sim.last = null;
  if (sim.playing) sim.raf = requestAnimationFrame(tick);
  drawSim();
});
$('sim-scrub').addEventListener('input', (e) => {
  if (!state.sim) return;
  state.sim.time = (e.target.value / 1000) * state.sim.model.duration;
  drawSim();
});
$('sim-tracks').addEventListener('change', () => state.sim && drawSim());
for (const id of ['sim-drivers', 'sim-standers', 'sim-speed', 'sim-maxspeed', 'sim-standerspeed', 'sim-flank']) {
  $(id).addEventListener('change', buildSim);
}

boot();
