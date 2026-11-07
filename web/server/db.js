const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// Imported map geometry (boundary.geojson, fields.geojson); baked into the Docker image.
const GEO_DIR = process.env.GEO_DIR || DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'drivehunt.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pw_hash  TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN ('viewer','editor'))
  );
  CREATE TABLE IF NOT EXISTS hunts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    seq        INTEGER NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    field_ids  TEXT NOT NULL DEFAULT '[]',
    arrow      TEXT,
    notes      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Field edits are stored as an overlay on top of the imported base fields
  -- (data/fields.geojson), so a re-import keeps manual work.
  CREATE TABLE IF NOT EXISTS field_hidden (
    id TEXT PRIMARY KEY          -- base field id replaced or deleted by an editor
  );
  CREATE TABLE IF NOT EXISTS field_props (
    id      TEXT PRIMARY KEY,    -- base field id
    name    TEXT,                -- overrides, NULL = keep imported value
    landuse TEXT
  );
  -- Map markers (meeting point, stand, parking, danger, ...) set by any user.
  CREATE TABLE IF NOT EXISTS markers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    type       TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS custom_fields (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    geometry   TEXT NOT NULL,
    name       TEXT,
    landuse    TEXT NOT NULL DEFAULT 'custom',
    parents    TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Shared to-do checklist (Aufgaben) for Bernd and Joost: a done flag, one
  -- "assigned/handled" flag per person and a free-text note. Visible to all users.
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    bernd      INTEGER NOT NULL DEFAULT 0,
    me         INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Start positions (Aufstellung) per drive, added after v1.
if (!db.prepare("SELECT 1 FROM pragma_table_info('hunts') WHERE name = 'setup'").get()) {
  db.exec('ALTER TABLE hunts ADD COLUMN setup TEXT');
}

// v1 stored only names for base fields.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'field_names'").get()) {
  db.exec('INSERT OR IGNORE INTO field_props (id, name) SELECT id, name FROM field_names; DROP TABLE field_names;');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Session signing secret, generated once and persisted next to the database.
const secretFile = path.join(DATA_DIR, 'session.secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();

module.exports = { db, DATA_DIR, GEO_DIR, hashPassword, verifyPassword, SESSION_SECRET };
