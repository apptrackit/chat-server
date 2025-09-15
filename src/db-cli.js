const { spawn } = require('child_process');
const path = require('path');

function getDbPath() {
  return process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');
}

function escapeSql(str) {
  if (str == null) return 'NULL';
  return `'${String(str).replaceAll("'", "''")}'`;
}

function runSql(sql) {
  return new Promise((resolve, reject) => {
    if (process.env.LOG_SQL === '1') {
      console.log('[SQL]', sql.replaceAll('\n', ' '));
    }
    const dbPath = getDbPath();
    const child = spawn('sqlite3', [dbPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => (err += d.toString()));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err || `sqlite3 exited with code ${code}`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function runQuery(sql) {
  return new Promise((resolve, reject) => {
    if (process.env.LOG_SQL === '1') {
      console.log('[SQL]', sql.replaceAll('\n', ' '));
    }
    const dbPath = getDbPath();
    const child = spawn('sqlite3', ['-header', '-csv', dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err || `sqlite3 exited with code ${code}`));
      out = out.trim();
      if (!out) return resolve([]);
      const lines = out.split(/\r?\n/);
      const header = parseCsvLine(lines[0]);
      const rows = lines.slice(1).map(line => {
        const cols = parseCsvLine(line);
        const obj = {};
        header.forEach((h, idx) => { obj[h] = cols[idx] === undefined ? null : cols[idx]; });
        return obj;
      });
      resolve(rows);
    });
  });
}

module.exports = {
  createDbClient() {
    // Create a pending join record
    async function createPending({ joinid, exp, client1 }) {
      const jid = escapeSql(joinid);
      const expv = escapeSql(exp);
      const c1 = escapeSql(client1);
      const sql = `BEGIN;\nINSERT INTO pendings(joinid, client1, exp, client2) VALUES (${jid}, ${c1}, ${expv}, NULL);\nCOMMIT;`;
      await runSql(sql);
      return { joinid, client1, exp, client2: null };
    }

    // Accept a pending join and create a room
    async function acceptPendingToRoom({ joinid, client2, roomid }) {
      const jid = escapeSql(joinid);
      const c2 = escapeSql(client2);
      const rid = escapeSql(roomid);
      // Atomic: insert room if pending exists and not expired; then set client2 on pending.
      const rows = await runQuery(`BEGIN;
INSERT OR IGNORE INTO rooms(roomid, client1, client2)
SELECT ${rid}, p.client1, ${c2}
FROM pendings p
WHERE p.joinid=${jid} AND p.exp > CURRENT_TIMESTAMP AND (p.client2 IS NULL OR p.client2='');
UPDATE pendings SET client2=${c2} WHERE joinid=${jid} AND exp > CURRENT_TIMESTAMP;
SELECT (SELECT COUNT(*) FROM rooms WHERE roomid=${rid}) AS created, (SELECT client1 FROM rooms WHERE roomid=${rid}) AS client1;
COMMIT;`);
      const res = rows?.[0];
      const created = res?.created ? parseInt(res.created, 10) : 0;
      if (!created) return { ok: false, code: 404 };
      return { ok: true, roomid, client1: res.client1 };
    }

    // Check pending status for client1
    async function checkPending({ joinid, client1 }) {
      const jid = escapeSql(joinid);
      const c1 = escapeSql(client1);
      const rows = await runQuery(`SELECT joinid, client1, client2 FROM pendings WHERE joinid=${jid} AND client1=${c1} AND exp > CURRENT_TIMESTAMP LIMIT 1;`);
      const row = rows?.[0];
      if (!row) return { status: 'not_found' };
      if (!row.client2) return { status: 'pending' };
      // lookup room by the two clients (there should be one)
      const roomRows = await runQuery(`SELECT roomid FROM rooms WHERE client1=${c1} AND client2=${escapeSql(row.client2)} LIMIT 1;`);
      const r = roomRows?.[0];
      if (!r) return { status: 'pending' };
      return { status: 'ready', roomid: r.roomid };
    }

    async function getRoomById(roomid) {
      const rid = escapeSql(roomid);
      const rows = await runQuery(`SELECT roomid, client1, client2 FROM rooms WHERE roomid=${rid} LIMIT 1;`);
      return rows?.[0] || null;
    }

    async function deleteRoom(roomid) {
      const rid = escapeSql(roomid);
      await runSql(`DELETE FROM rooms WHERE roomid=${rid};`);
    }

    async function cleanupExpired() {
      // Remove expired pendings
      const rows = await runQuery(`BEGIN; DELETE FROM pendings WHERE exp <= CURRENT_TIMESTAMP; SELECT changes() AS deleted; COMMIT;`);
      const deleted = rows?.[0]?.deleted ? parseInt(rows[0].deleted, 10) : 0;
      return Number.isNaN(deleted) ? 0 : deleted;
    }

    return { createPending, acceptPendingToRoom, checkPending, getRoomById, deleteRoom, cleanupExpired };
  }
};
