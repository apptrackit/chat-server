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
    async function createPending({ joinid, exp, client1, client1_token = null, platform = null }) {
      const jid = escapeSql(joinid);
      const expv = escapeSql(exp);
      const c1 = escapeSql(client1);
      const token = escapeSql(client1_token);
      const plat = escapeSql(platform);
      const sql = `BEGIN;\nINSERT INTO pendings(joinid, client1, exp, client2, client1_token, platform) VALUES (${jid}, ${c1}, ${expv}, NULL, ${token}, ${plat});\nCOMMIT;`;
      await runSql(sql);
      return { joinid, client1, exp, client2: null, client1_token, platform };
    }

    // Accept a pending join and create a room
    async function acceptPendingToRoom({ joinid, client2, roomid, client2_token = null, platform = null }) {
      const jid = escapeSql(joinid);
      const c2 = escapeSql(client2);
      const rid = escapeSql(roomid);
      const token2 = escapeSql(client2_token);
      const plat2 = escapeSql(platform);
      // Do everything in ONE atomic transaction to avoid race conditions
      // Delete expired first, then insert room with tokens, all using the same datetime('now') evaluation
      const rows = await runQuery(`BEGIN;
DELETE FROM pendings WHERE datetime(exp) <= datetime('now');
INSERT OR IGNORE INTO rooms(roomid, client1, client2, client1_token, client2_token, client1_platform, client2_platform)
SELECT ${rid}, p.client1, ${c2}, p.client1_token, ${token2}, p.platform, ${plat2}
FROM pendings p
WHERE p.joinid=${jid} AND datetime(p.exp) > datetime('now') AND (p.client2 IS NULL OR p.client2='');
UPDATE pendings SET client2=${c2} WHERE joinid=${jid} AND datetime(exp) > datetime('now');
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
      // Do cleanup and query in ONE transaction to use same datetime('now')
      const rows = await runQuery(`BEGIN;
DELETE FROM pendings WHERE datetime(exp) <= datetime('now');
SELECT joinid, client1, client2 FROM pendings WHERE joinid=${jid} AND client1=${c1} AND datetime(exp) > datetime('now') LIMIT 1;
COMMIT;`);
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
      const rows = await runQuery(`SELECT roomid, client1, client2, client1_token, client2_token, client1_platform, client2_platform FROM rooms WHERE roomid=${rid} LIMIT 1;`);
      return rows?.[0] || null;
    }

    async function deleteRoom(roomid) {
      const rid = escapeSql(roomid);
      await runSql(`DELETE FROM rooms WHERE roomid=${rid};`);
    }

    async function deletePending(joinid, client1) {
      const jid = escapeSql(joinid);
      const c1 = escapeSql(client1);
      const rows = await runQuery(`BEGIN; DELETE FROM pendings WHERE joinid=${jid} AND client1=${c1}; SELECT changes() AS deleted; COMMIT;`);
      const deleted = rows?.[0]?.deleted ? parseInt(rows[0].deleted, 10) : 0;
      return Number.isNaN(deleted) ? 0 : deleted;
    }

    async function cleanupExpired() {
      // Remove expired pendings (compare as datetime, not string)
      const rows = await runQuery(`BEGIN; DELETE FROM pendings WHERE datetime(exp) <= datetime('now'); SELECT changes() AS deleted; COMMIT;`);
      const deleted = rows?.[0]?.deleted ? parseInt(rows[0].deleted, 10) : 0;
      return Number.isNaN(deleted) ? 0 : deleted;
    }

    // Purge all rows related to device ID(s) from rooms and pendings
    // Accepts either a single deviceId string or array of deviceIds
    async function purgeByDevice(deviceIds) {
      // Normalize to array
      const idsArray = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
      
      if (idsArray.length === 0) {
        return { roomsDeleted: 0, pendingsDeleted: 0 };
      }
      
      // Build SQL IN clause: (client1 IN (...) OR client2 IN (...))
      const escapedIds = idsArray.map(id => escapeSql(id)).join(',');
      
      // Delete from rooms and get count
      const roomRows = await runQuery(
        `BEGIN; ` +
        `DELETE FROM rooms WHERE client1 IN (${escapedIds}) OR client2 IN (${escapedIds}); ` +
        `SELECT changes() AS deleted; ` +
        `COMMIT;`
      );
      const roomsDeleted = roomRows?.[0]?.deleted ? parseInt(roomRows[0].deleted, 10) : 0;
      
      // Delete from pendings and get count
      const pendingRows = await runQuery(
        `BEGIN; ` +
        `DELETE FROM pendings WHERE client1 IN (${escapedIds}) OR client2 IN (${escapedIds}); ` +
        `SELECT changes() AS deleted; ` +
        `COMMIT;`
      );
      const pendingsDeleted = pendingRows?.[0]?.deleted ? parseInt(pendingRows[0].deleted, 10) : 0;
      
      return { 
        roomsDeleted: Number.isNaN(roomsDeleted) ? 0 : roomsDeleted, 
        pendingsDeleted: Number.isNaN(pendingsDeleted) ? 0 : pendingsDeleted,
        deviceIdCount: idsArray.length
      };
    }

    /**
     * Update or remove a device token for a specific client in a room.
     * Used to purge invalid tokens when APNs returns BadDeviceToken.
     * 
     * @param {string} roomid - The room ID
     * @param {string} clientField - Either 'client1' or 'client2'
     * @param {string|null} newToken - New token value (null to remove)
     * @returns {Promise<boolean>} - True if updated successfully
     */
    async function updateRoomToken(roomid, clientField, newToken) {
      if (!roomid || (clientField !== 'client1' && clientField !== 'client2')) {
        throw new Error('Invalid parameters for updateRoomToken');
      }
      
      const rid = escapeSql(roomid);
      const tokenField = clientField === 'client1' ? 'client1_token' : 'client2_token';
      const tokenValue = newToken ? escapeSql(newToken) : 'NULL';
      
      const rows = await runQuery(
        `BEGIN; ` +
        `UPDATE rooms SET ${tokenField}=${tokenValue} WHERE roomid=${rid}; ` +
        `SELECT changes() AS updated; ` +
        `COMMIT;`
      );
      
      const updated = rows?.[0]?.updated ? parseInt(rows[0].updated, 10) : 0;
      return updated > 0;
    }

  return { createPending, acceptPendingToRoom, checkPending, getRoomById, deleteRoom, deletePending, cleanupExpired, purgeByDevice, updateRoomToken };
  }
};
