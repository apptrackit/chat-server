-- Minimal single-table schema for signaling rooms
-- 0 = pending, 1 = connected

CREATE TABLE IF NOT EXISTS rooms (
  roomid VARCHAR(32) NOT NULL PRIMARY KEY,
  exp DATETIME NOT NULL,
  client1 VARCHAR(128) NOT NULL,
  client2 VARCHAR(128),
  status BOOLEAN NOT NULL DEFAULT 0
);
