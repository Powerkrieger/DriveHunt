#!/usr/bin/env node
// User management.
//   node scripts/user.js add <username> <viewer|editor> [password]   (prompts / generates if omitted)
//   node scripts/user.js passwd <username> [password]
//   node scripts/user.js del <username>
//   node scripts/user.js list

const crypto = require('node:crypto');
const { db, hashPassword } = require('../server/db');

const [cmd, rawName, a, b] = process.argv.slice(2);
const name = rawName?.trim().toLowerCase();
const genPassword = () => crypto.randomBytes(9).toString('base64url');

function usage() {
  console.log('usage: user.js add <name> <viewer|editor> [password] | passwd <name> [password] | del <name> | list');
  process.exit(1);
}

switch (cmd) {
  case 'add': {
    if (!name || !['viewer', 'editor'].includes(a)) usage();
    const pw = b || genPassword();
    db.prepare('INSERT OR REPLACE INTO users (username, pw_hash, role) VALUES (?, ?, ?)').run(name, hashPassword(pw), a);
    console.log(`User "${name}" (${a}) saved.${b ? '' : ` Password: ${pw}`}`);
    break;
  }
  case 'passwd': {
    if (!name) usage();
    const pw = a || genPassword();
    const r = db.prepare('UPDATE users SET pw_hash = ? WHERE username = ?').run(hashPassword(pw), name);
    console.log(r.changes ? `Password updated.${a ? '' : ` New password: ${pw}`}` : 'No such user.');
    break;
  }
  case 'del':
    if (!name) usage();
    db.prepare('DELETE FROM users WHERE username = ?').run(name);
    console.log('Deleted.');
    break;
  case 'list':
    for (const u of db.prepare('SELECT username, role FROM users ORDER BY username').all()) console.log(`${u.username}\t${u.role}`);
    break;
  default:
    usage();
}
