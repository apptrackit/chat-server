// Minimal SQLite wrapper using better-sqlite3 (sync, fast)
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');
const DEFAULT_SCHEMA = path.join(__dirname, '..', 'scripts', 'init-db.sql');

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDb(dbPath = DEFAULT_DB_PATH) {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  // Apply schema once
  const schema = fs.readFileSync(DEFAULT_SCHEMA, 'utf-8');
  db.exec(schema);

  // Pragmas that are safe to set each open
  db.pragma('foreign_keys = ON');

  return db;
}

let dbInstance;
function getDb() {
  if (!dbInstance) {
    dbInstance = initDb();
  }
  return dbInstance;
}

module.exports = {
  getDb,
};
