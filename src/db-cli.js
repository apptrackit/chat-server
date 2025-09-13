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
    return { onJoin, onLeave, deleteRoom };
  }
};
