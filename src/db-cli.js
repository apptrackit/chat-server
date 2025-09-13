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

async function onJoin(roomId, clientId, isFirstUser) {
  const expSql = "datetime('now','+1 hour')";
  const rid = escapeSql(roomId);
  const cid = escapeSql(clientId);

  if (isFirstUser) {
    const sql = `BEGIN;
INSERT OR IGNORE INTO rooms(roomid, exp, client1, client2, status) VALUES (${rid}, ${expSql}, ${cid}, NULL, 0);
UPDATE rooms SET client1=${cid}, client2=CASE WHEN client2 IS NULL THEN NULL ELSE client2 END, exp=${expSql}, status=0 WHERE roomid=${rid};
COMMIT;`;
    try { await runSql(sql); } catch (e) { /* ignore but available for logs */ }
  } else {
    const sql = `BEGIN;
UPDATE rooms SET client2=${cid}, status=1 WHERE roomid=${rid};
COMMIT;`;
    try { await runSql(sql); } catch (e) { /* ignore */ }
  }
}

async function onLeave(roomId, clientId) {
  const rid = escapeSql(roomId);
  const cid = escapeSql(clientId);
  const sql = `BEGIN;
-- If leaving is client2, just null client2 and mark pending
UPDATE rooms SET client2=NULL, status=0 WHERE roomid=${rid} AND client2=${cid};
-- If leaving is client1, promote client2 to client1 when present
UPDATE rooms SET client1=client2, client2=NULL, status=0 WHERE roomid=${rid} AND client1=${cid} AND client2 IS NOT NULL;
-- If after updates both clients are NULL (room empty), delete the room
DELETE FROM rooms WHERE roomid=${rid} AND (client1 IS NULL OR client1='') AND client2 IS NULL;
COMMIT;`;
  try { await runSql(sql); } catch (e) { /* ignore */ }
}

async function deleteRoom(roomId) {
  const rid = escapeSql(roomId);
  const sql = `DELETE FROM rooms WHERE roomid=${rid};`;
  try { await runSql(sql); } catch (e) { /* ignore */ }
}

module.exports = {
  createDbClient() {
    async function createRoom({ roomid, exp, client1 }) {
      const rid = escapeSql(roomid);
      const expv = escapeSql(exp);
      const c1 = escapeSql(client1);
      const sql = `BEGIN;
INSERT INTO rooms(roomid, exp, client1, client2, status) VALUES (${rid}, ${expv}, ${c1}, NULL, 0);
COMMIT;`;
      await runSql(sql);
      const [row] = await runQuery(`SELECT roomid, exp, client1, client2, status FROM rooms WHERE roomid=${rid} LIMIT 1;`);
      return row || null;
    }

    async function acceptRoom({ roomid, client2 }) {
      const rid = escapeSql(roomid);
      const c2 = escapeSql(client2);
      const sql = `BEGIN;
UPDATE rooms SET client2=${c2}, status=1 WHERE roomid=${rid} AND status=0 AND exp > CURRENT_TIMESTAMP;
SELECT changes() AS changes;
COMMIT;`;
      const rows = await runQuery(sql);
      const changes = rows?.[0]?.changes ? parseInt(rows[0].changes, 10) : 0;
      if (Number.isNaN(changes)) return 0;
      return changes;
    }

    async function getRoom(roomid) {
      const rid = escapeSql(roomid);
      const rows = await runQuery(`SELECT roomid, exp, client1, client2, status FROM rooms WHERE roomid=${rid} LIMIT 1;`);
      return rows[0] || null;
    }

    async function cleanupExpired() {
      const rows = await runQuery(`BEGIN; DELETE FROM rooms WHERE status=0 AND exp <= CURRENT_TIMESTAMP; SELECT changes() AS deleted; COMMIT;`);
      const deleted = rows?.[0]?.deleted ? parseInt(rows[0].deleted, 10) : 0;
      return Number.isNaN(deleted) ? 0 : deleted;
    }

    return { onJoin, onLeave, deleteRoom, createRoom, acceptRoom, getRoom, cleanupExpired };
  }
};
