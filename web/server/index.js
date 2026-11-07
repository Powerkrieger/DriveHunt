const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const pc = require('polygon-clipping');
const { db, GEO_DIR, hashPassword, verifyPassword, SESSION_SECRET } = require('./db');

const PORT = Number(process.env.PORT || 8080);
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // set to 1 when served via HTTPS
const SESSION_DAYS = 30;
const COOKIE = 'dh_session';

const app = express();
// Behind Caddy in Docker the proxy has a private IP: TRUST_PROXY=uniquelocal
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(express.json({ limit: '2mb' }));

// ---------- sessions (HMAC-signed cookie, stateless) ----------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res, value, maxAgeSec) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

app.use((req, _res, next) => {
  const s = unsign(readCookie(req, COOKIE));
  // Re-check the user on every request so deleted users / role changes take effect immediately.
  if (s) {
    const u = db.prepare('SELECT username, role FROM users WHERE username = ?').get(s.u);
    if (u) req.user = u;
  }
  next();
});

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
const requireEditor = (req, res, next) =>
  req.user?.role === 'editor' ? next() : res.status(403).json({ error: 'Keine Bearbeitungsrechte' });

// ---------- auth ----------

const failedLogins = new Map(); // ip -> { count, until }
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failedLogins.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Zu viele Versuche, bitte kurz warten' });

  const { username, password } = req.body || {};
  const u = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!u || typeof password !== 'string' || !verifyPassword(password, u.pw_hash)) {
    const count = (f?.count || 0) + 1;
    failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
  }
  failedLogins.delete(ip);
  setSessionCookie(res, sign({ u: u.username, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
  res.json({ username: u.username, role: u.role });
});

app.post('/api/logout', (_req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json(req.user));

// Change own password: verify the current one, then store a fresh scrypt hash.
app.post('/api/password', requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user.username);
  if (!u || typeof current !== 'string' || !verifyPassword(current, u.pw_hash)) {
    return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
  }
  if (typeof next !== 'string' || next.length < 6 || next.length > 200) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });
  }
  db.prepare('UPDATE users SET pw_hash = ? WHERE username = ?').run(hashPassword(next), u.username);
  res.json({ ok: true });
});

// ---------- map data ----------

// Base fields come from data/fields.geojson (import script); editor changes are
// applied on top: hidden base fields, renamed base fields, custom fields.
// Base = official/OSM field blocks + OSM forest/scrub/water (nature.geojson, optional).
const BASE_FILES = ['fields.geojson', 'nature.geojson'];
const LANDUSES = ['farmland', 'meadow', 'grass', 'grassland', 'forest', 'scrub', 'water', 'other', 'custom'];
const baseCache = new Map(); // file -> { mtime, data }
function baseFields() {
  const features = [], attribution = [];
  for (const name of BASE_FILES) {
    const file = path.join(GEO_DIR, name);
    if (!fs.existsSync(file)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (baseCache.get(file)?.mtime !== mtime) baseCache.set(file, { mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
    const { data } = baseCache.get(file);
    features.push(...data.features);
    if (data.attribution) attribution.push(data.attribution);
  }
  return { features, attribution: attribution.join(', ') };
}

function effectiveFields() {
  const base = baseFields();
  const hidden = new Set(db.prepare('SELECT id FROM field_hidden').all().map((r) => r.id));
  const props = new Map(db.prepare('SELECT * FROM field_props').all().map((r) => [r.id, r]));
  const features = base.features
    .filter((f) => !hidden.has(f.id))
    .map((f) => {
      const o = props.get(f.id);
      if (!o) return f;
      return { ...f, properties: { ...f.properties, name: o.name ?? f.properties.name, landuse: o.landuse ?? f.properties.landuse } };
    });
  for (const c of db.prepare('SELECT * FROM custom_fields ORDER BY id').all()) {
    const id = `custom/${c.id}`;
    features.push({
      type: 'Feature',
      id,
      properties: { id, landuse: c.landuse, name: c.name, custom: true, parents: JSON.parse(c.parents) },
      geometry: JSON.parse(c.geometry),
    });
  }
  return { type: 'FeatureCollection', attribution: base.attribution, features };
}

app.get('/api/geo', requireUser, (_req, res) => {
  res.json({
    boundary: JSON.parse(fs.readFileSync(path.join(GEO_DIR, 'boundary.geojson'), 'utf8')),
    fields: effectiveFields(),
  });
});

function validGeometry(g) {
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type) || !Array.isArray(g.coordinates)) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let vertices = 0;
  for (const poly of polys) {
    if (!Array.isArray(poly) || !poly.length) return false;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length < 2 || !pt.every(Number.isFinite)) return false;
        if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) return false;
        vertices++;
      }
    }
  }
  return vertices <= 20000;
}

// Fields never extend beyond the town limits: cut off what sticks out.
let townCache = { mtime: 0, multi: null };
function clipToTown(geometry) {
  const file = path.join(GEO_DIR, 'boundary.geojson');
  const mtime = fs.statSync(file).mtimeMs;
  if (mtime !== townCache.mtime) {
    const g = JSON.parse(fs.readFileSync(file, 'utf8')).geometry;
    townCache = { mtime, multi: g.type === 'Polygon' ? [g.coordinates] : g.coordinates };
  }
  const inside = pc.intersection(geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates, townCache.multi);
  if (!inside.length) return null;
  return inside.length === 1 ? { type: 'Polygon', coordinates: inside[0] } : { type: 'MultiPolygon', coordinates: inside };
}

// One operation for every field edit: draw (remove nothing), split (1 -> n),
// merge (n -> 1), reshape (1 -> 1), delete (n -> nothing).
// Drives that used a removed field get the new fields instead.
app.post('/api/fields/replace', requireEditor, (req, res) => {
  const { remove, add } = req.body || {};
  if (!Array.isArray(remove) || !Array.isArray(add) || remove.length + add.length === 0 || add.length > 50)
    return res.status(400).json({ error: 'Ungültige Anfrage' });
  if (!add.every((a) => a && validGeometry(a.geometry) && (a.name == null || (typeof a.name === 'string' && a.name.length <= 100))))
    return res.status(400).json({ error: 'Ungültige Geometrie' });

  const clipped = add.map((a) => ({ ...a, geometry: clipToTown(a.geometry) }));
  if (clipped.some((a) => !a.geometry)) return res.status(400).json({ error: 'Die Fläche liegt außerhalb der Gemeindegrenze' });

  const current = new Map(effectiveFields().features.map((f) => [f.id, f]));
  if (!remove.every((id) => current.has(id))) return res.status(409).json({ error: 'Feld existiert nicht mehr – bitte neu laden' });

  const landuse = remove.length ? current.get(remove[0]).properties.landuse : 'custom';
  const added = [];
  db.exec('BEGIN');
  try {
    for (const id of remove) {
      if (id.startsWith('custom/')) db.prepare('DELETE FROM custom_fields WHERE id = ?').run(Number(id.slice(7)));
      else db.prepare('INSERT OR IGNORE INTO field_hidden (id) VALUES (?)').run(id);
    }
    for (const a of clipped) {
      const r = db
        .prepare('INSERT INTO custom_fields (geometry, name, landuse, parents, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(JSON.stringify(a.geometry), a.name || null, landuse, JSON.stringify(remove), req.user.username);
      added.push(`custom/${r.lastInsertRowid}`);
    }
    if (remove.length) {
      const removed = new Set(remove);
      for (const h of db.prepare('SELECT id, field_ids FROM hunts').all()) {
        const ids = JSON.parse(h.field_ids);
        if (!ids.some((id) => removed.has(id))) continue;
        const next = [...new Set([...ids.filter((id) => !removed.has(id)), ...added])];
        db.prepare("UPDATE hunts SET field_ids = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(next), h.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  broadcast('fields');
  broadcast('hunts');
  res.json({ added });
});

// Rename a field and/or change its type (e.g. a hand-drawn pond -> water).
app.post('/api/fields/props', requireEditor, (req, res) => {
  const { id, name, landuse } = req.body || {};
  if (typeof id !== 'string' || (name != null && (typeof name !== 'string' || name.length > 100)) || (landuse != null && !LANDUSES.includes(landuse)))
    return res.status(400).json({ error: 'Ungültige Anfrage' });
  const field = effectiveFields().features.find((f) => f.id === id);
  if (!field) return res.status(404).json({ error: 'Feld nicht gefunden' });
  const clean = name?.trim() || null;
  const lu = landuse || field.properties.landuse;
  if (id.startsWith('custom/')) {
    db.prepare('UPDATE custom_fields SET name = ?, landuse = ? WHERE id = ?').run(clean, lu, Number(id.slice(7)));
  } else {
    db.prepare('INSERT OR REPLACE INTO field_props (id, name, landuse) VALUES (?, ?, ?)').run(id, clean, lu);
  }
  broadcast('fields');
  res.json({ ok: true });
});

// ---------- markers (all users) ----------
// Everyone logged in can set markers; users edit / delete their own, editors all.

const MARKER_TYPES = ['treffpunkt', 'hochsitz', 'parkplatz', 'gefahr', 'wild', 'sonstiges'];
function validMarker(b) {
  return (
    b && Number.isFinite(b.lat) && Math.abs(b.lat) <= 90 && Number.isFinite(b.lng) && Math.abs(b.lng) <= 180 &&
    MARKER_TYPES.includes(b.type) &&
    (b.label == null || (typeof b.label === 'string' && b.label.length <= 100)) &&
    (b.note == null || (typeof b.note === 'string' && b.note.length <= 1000))
  );
}
const canEditMarker = (user, m) => user.role === 'editor' || m.created_by === user.username;

app.get('/api/markers', requireUser, (_req, res) => res.json(db.prepare('SELECT * FROM markers ORDER BY id').all()));

app.post('/api/markers', requireUser, (req, res) => {
  const b = req.body;
  if (!validMarker(b)) return res.status(400).json({ error: 'Ungültige Markierung' });
  const r = db
    .prepare('INSERT INTO markers (lat, lng, type, label, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.lat, b.lng, b.type, (b.label || '').trim(), (b.note || '').trim(), req.user.username);
  broadcast('markers');
  res.status(201).json(db.prepare('SELECT * FROM markers WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/markers/:id', requireUser, (req, res) => {
  const m = db.prepare('SELECT * FROM markers WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!canEditMarker(req.user, m)) return res.status(403).json({ error: 'Nur eigene Markierungen können geändert werden' });
  const b = { ...m, ...req.body };
  if (!validMarker(b)) return res.status(400).json({ error: 'Ungültige Markierung' });
  db.prepare("UPDATE markers SET lat = ?, lng = ?, type = ?, label = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(b.lat, b.lng, b.type, (b.label || '').trim(), (b.note || '').trim(), m.id);
  broadcast('markers');
  res.json(db.prepare('SELECT * FROM markers WHERE id = ?').get(m.id));
});

app.delete('/api/markers/:id', requireUser, (req, res) => {
  const m = db.prepare('SELECT * FROM markers WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.json({ ok: true });
  if (!canEditMarker(req.user, m)) return res.status(403).json({ error: 'Nur eigene Markierungen können gelöscht werden' });
  db.prepare('DELETE FROM markers WHERE id = ?').run(m.id);
  broadcast('markers');
  res.json({ ok: true });
});

// ---------- todos (Aufgaben) ----------
// Private checklist for editors only: a "done" flag, a flag for Bernd and one
// for "me" (Ich), plus a free-text note. Viewers can't see or change it.

const bit = (v) => (v ? 1 : 0);
const rowToTodo = (r) => ({ ...r, done: !!r.done, bernd: !!r.bernd, me: !!r.me });

function validTodo(b) {
  return (
    b &&
    (b.text == null || (typeof b.text === 'string' && b.text.length <= 1000)) &&
    ['done', 'bernd', 'me'].every((k) => b[k] == null || typeof b[k] === 'boolean')
  );
}

app.get('/api/todos', requireEditor, (_req, res) =>
  res.json(db.prepare('SELECT * FROM todos ORDER BY done, id').all().map(rowToTodo))
);

app.post('/api/todos', requireEditor, (req, res) => {
  const b = req.body || {};
  if (!validTodo(b)) return res.status(400).json({ error: 'Ungültige Aufgabe' });
  const r = db
    .prepare('INSERT INTO todos (text, done, bernd, me, created_by) VALUES (?, ?, ?, ?, ?)')
    .run((b.text || '').trim(), bit(b.done), bit(b.bernd), bit(b.me), req.user.username);
  broadcast('todos');
  res.status(201).json(rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(r.lastInsertRowid)));
});

app.put('/api/todos/:id', requireEditor, (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const b = { ...rowToTodo(t), ...req.body };
  if (!validTodo(b)) return res.status(400).json({ error: 'Ungültige Aufgabe' });
  db.prepare("UPDATE todos SET text = ?, done = ?, bernd = ?, me = ?, updated_at = datetime('now') WHERE id = ?")
    .run((b.text || '').trim(), bit(b.done), bit(b.bernd), bit(b.me), t.id);
  broadcast('todos');
  res.json(rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(t.id)));
});

app.delete('/api/todos/:id', requireEditor, (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(Number(req.params.id));
  broadcast('todos');
  res.json({ ok: true });
});

// ---------- hunts (Treiben) ----------

const parseOr = (x, dflt) => (x ? JSON.parse(x) : dflt);
const rowToHunt = (r) => ({ ...r, field_ids: JSON.parse(r.field_ids), arrow: parseOr(r.arrow, null), setup: parseOr(r.setup, null) });
const listHunts = () => db.prepare('SELECT * FROM hunts ORDER BY seq, id').all().map(rowToHunt);

function validateHunt(b) {
  const errors = [];
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) errors.push('name');
  if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color)) errors.push('color');
  if (!Number.isInteger(b.seq) || b.seq < 0 || b.seq > 999) errors.push('seq');
  if (!Array.isArray(b.field_ids) || b.field_ids.some((x) => typeof x !== 'string')) errors.push('field_ids');
  const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (b.arrow != null && !(Array.isArray(b.arrow) && b.arrow.length >= 2 && b.arrow.length <= 50 && b.arrow.every(isPt))) errors.push('arrow');
  const ptList = (x, max) => Array.isArray(x) && x.length <= max && x.every(isPt);
  if (b.setup != null && !(typeof b.setup === 'object' && ptList(b.setup.drivers, 100) && ptList(b.setup.standers, 50)))
    errors.push('setup');
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 2000)) errors.push('notes');
  return errors;
}

const json = (x) => (x == null ? null : JSON.stringify(x));
const setupOf = (b) => (b.setup && (b.setup.drivers.length || b.setup.standers.length) ? { drivers: b.setup.drivers, standers: b.setup.standers } : null);

// Server-sent events so every open map updates when an editor saves.
const clients = new Set();
app.get('/api/events', requireUser, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});
const broadcast = (event) => {
  for (const c of clients) c.write(`event: ${event}\ndata: changed\n\n`);
};

app.get('/api/hunts', requireUser, (_req, res) => res.json(listHunts()));

app.post('/api/hunts', requireEditor, (req, res) => {
  const errors = validateHunt(req.body);
  if (errors.length) return res.status(400).json({ error: 'Ungültige Felder: ' + errors.join(', ') });
  const b = req.body;
  const r = db
    .prepare('INSERT INTO hunts (seq, name, color, field_ids, arrow, setup, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(b.seq, b.name.trim(), b.color, JSON.stringify(b.field_ids), json(b.arrow), json(setupOf(b)), b.notes || '');
  broadcast('hunts');
  res.status(201).json(rowToHunt(db.prepare('SELECT * FROM hunts WHERE id = ?').get(r.lastInsertRowid)));
});

app.put('/api/hunts/:id', requireEditor, (req, res) => {
  const errors = validateHunt(req.body);
  if (errors.length) return res.status(400).json({ error: 'Ungültige Felder: ' + errors.join(', ') });
  const b = req.body;
  const r = db
    .prepare(
      "UPDATE hunts SET seq = ?, name = ?, color = ?, field_ids = ?, arrow = ?, setup = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(b.seq, b.name.trim(), b.color, JSON.stringify(b.field_ids), json(b.arrow), json(setupOf(b)), b.notes || '', Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  broadcast('hunts');
  res.json(rowToHunt(db.prepare('SELECT * FROM hunts WHERE id = ?').get(Number(req.params.id))));
});

app.delete('/api/hunts/:id', requireEditor, (req, res) => {
  db.prepare('DELETE FROM hunts WHERE id = ?').run(Number(req.params.id));
  broadcast('hunts');
  res.json({ ok: true });
});

// ---------- static files ----------

const vendor = (url, dir) => app.use(url, express.static(path.join(__dirname, '..', 'node_modules', dir)));
vendor('/vendor/leaflet', 'leaflet/dist');
vendor('/vendor/geoman', '@geoman-io/leaflet-geoman-free/dist');
vendor('/vendor/polygon-clipping', 'polygon-clipping/dist');
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => console.log(`drivehunt listening on http://localhost:${PORT}`));
