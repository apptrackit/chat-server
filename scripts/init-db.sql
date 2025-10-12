-- New schema: pendings and rooms
-- pendings: temporary join codes awaiting acceptance
-- rooms: established room mapping between two clients

PRAGMA foreign_keys = ON;

-- Drop old tables if present
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS pendings;

-- Pending join requests created by client1
CREATE TABLE IF NOT EXISTS pendings (
  joinid TEXT NOT NULL PRIMARY KEY,
  client1 TEXT NOT NULL,
  exp DATETIME NOT NULL, -- store as ISO8601 UTC string
  client2 TEXT,
  client1_token TEXT, -- APNs/FCM device token for iOS/Android
  platform TEXT -- 'ios' or 'android' for cross-platform support
);

CREATE INDEX IF NOT EXISTS idx_pendings_client1 ON pendings(client1);
CREATE INDEX IF NOT EXISTS idx_pendings_exp ON pendings(exp);

-- Auto-cleanup expired pendings using a comprehensive trigger strategy
-- Triggers fire on write operations and aggressively clean expired rows
-- Use datetime() function to properly compare ISO8601 timestamps

DROP TRIGGER IF EXISTS cleanup_expired_on_insert;
CREATE TRIGGER cleanup_expired_on_insert
AFTER INSERT ON pendings
BEGIN
  DELETE FROM pendings WHERE datetime(exp) <= datetime('now');
END;

DROP TRIGGER IF EXISTS cleanup_expired_on_update;  
CREATE TRIGGER cleanup_expired_on_update
AFTER UPDATE ON pendings
BEGIN
  DELETE FROM pendings WHERE datetime(exp) <= datetime('now');
END;

-- Established rooms after acceptance
CREATE TABLE IF NOT EXISTS rooms (
  roomid TEXT NOT NULL PRIMARY KEY,
  client1 TEXT NOT NULL,
  client2 TEXT NOT NULL,
  client1_token TEXT, -- APNs/FCM device token for iOS/Android
  client2_token TEXT, -- APNs/FCM device token for iOS/Android
  client1_platform TEXT, -- 'ios' or 'android'
  client2_platform TEXT -- 'ios' or 'android'
);

CREATE INDEX IF NOT EXISTS idx_rooms_client1 ON rooms(client1);
CREATE INDEX IF NOT EXISTS idx_rooms_client2 ON rooms(client2);

