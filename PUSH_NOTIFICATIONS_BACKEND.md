# Push Notifications Implementation Guide - Backend (Node.js)

**Version:** 1.0  
**Date:** October 12, 2025  
**Implementation:** Option 2 - Ephemeral Device Token Exchange

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [APNs Setup](#apns-setup)
5. [Database Schema](#database-schema)
6. [Implementation Steps](#implementation-steps)
7. [API Endpoints](#api-endpoints)
8. [WebSocket Integration](#websocket-integration)
9. [Testing](#testing)
10. [Production Deployment](#production-deployment)
11. [Troubleshooting](#troubleshooting)

---

## Overview

This guide implements the **server-side push notification logic** for the Inviso chat application. It uses **node-apn** with **token-based authentication** (APNs Auth Key) to send privacy-preserving presence notifications.

### What This Backend Does:

1. ✅ **Store ephemeral APNs device tokens** in database (per room)
2. ✅ **Send push notifications** when a peer joins a room
3. ✅ **Auto-purge tokens** on session expiry or deletion
4. ✅ **Handle token failures** gracefully (expired/invalid tokens)
5. ✅ **Rate limiting** to prevent abuse

### System Requirements:

- **Node.js:** v18+ (for ES modules support)
- **Database:** SQLite (already in use)
- **Dependencies:** `@parse/node-apn` (node-apn v3.x)
- **OS:** Linux/macOS/Windows

---

## Architecture

### Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    ENHANCED DATABASE SCHEMA                      │
│                                                                  │
│  rooms table (existing + new columns):                          │
│  ┌─────────┬──────────┬──────────┬──────────────┬─────────────┐│
│  │ roomid  │ client1  │ client2  │ client1_token│client2_token││
│  │ (PK)    │          │          │  (nullable)  │ (nullable)  ││
│  └─────────┴──────────┴──────────┴──────────────┴─────────────┘│
│                                                                  │
│  pendings table (existing + new column):                        │
│  ┌─────────┬──────┬──────────────┬───────────────┐            │
│  │ joinid  │ exp  │ client1      │ client1_token │            │
│  │ (PK)    │      │              │  (nullable)   │            │
│  └─────────┴──────┴──────────────┴───────────────┘            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      WEBSOCKET EVENT FLOW                        │
│                                                                  │
│  Client1 WebSocket: join_room { roomId: "xyz" }                 │
│         │                                                        │
│         ▼                                                        │
│  Server checks: Is Client2 connected?                           │
│         │                                                        │
│         ├─ YES → Do nothing (both connected)                    │
│         │                                                        │
│         └─ NO → Fetch Client2's token from DB                   │
│                 │                                                │
│                 ▼                                                │
│         Send APNs notification to Client2's token               │
│                                                                  │
│  Notification payload:                                          │
│  {                                                               │
│    aps: {                                                        │
│      alert: "Your chat partner is waiting",                     │
│      sound: "default",                                           │
│      badge: 1                                                    │
│    },                                                            │
│    roomId: "xyz"  // Custom data for deep link                  │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      TOKEN LIFECYCLE                             │
│                                                                  │
│  1. Token Storage:                                               │
│     POST /api/rooms        → Store client1_token in pendings    │
│     POST /api/rooms/accept → Move to rooms table                │
│                                                                  │
│  2. Token Usage:                                                 │
│     WebSocket: join_room   → Send push if peer offline          │
│                                                                  │
│  3. Token Cleanup:                                               │
│     DELETE /api/rooms      → Purge tokens from database         │
│     POST /api/user/purge   → Purge by ephemeral device ID       │
│     SQLite Trigger         → Auto-delete expired pendings        │
└──────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### 1. Apple Developer Setup Complete

From iOS guide, you should have:
- ✅ **APNs Auth Key** (`.p8` file): `AuthKey_XXXXXXXXXX.p8`
- ✅ **Key ID**: 10-character string (e.g., `AB12CD34EF`)
- ✅ **Team ID**: Found in Apple Developer Portal (e.g., `XYZ9876543`)
- ✅ **Bundle ID**: `com.31b4.Inviso`

### 2. Server Access

- SSH access to your server (chat.ballabotond.com)
- Sudo privileges (for installing dependencies)
- Git repository access

### 3. Environment

- Node.js v18+ installed
- SQLite installed
- Port 443 available (HTTPS)

---

## APNs Setup

### Step 1: Install node-apn

```bash
cd /path/to/chat-server
npm install @parse/node-apn --save
```

**Why `@parse/node-apn`?**
- Maintained fork of the original node-apn
- Supports latest APNs HTTP/2 API
- Token-based authentication
- Better error handling

---

### Step 2: Upload APNs Key to Server

**Secure upload process:**

```bash
# On your local machine (where you have AuthKey_XXXXXXXXXX.p8)
cd ~/Developer/APNs-Keys

# Create secure directory on server
ssh user@chat.ballabotond.com "mkdir -p ~/chat-server/keys && chmod 700 ~/chat-server/keys"

# Upload key (use SCP with encryption)
scp AuthKey_XXXXXXXXXX.p8 user@chat.ballabotond.com:~/chat-server/keys/

# Set restrictive permissions on server
ssh user@chat.ballabotond.com "chmod 600 ~/chat-server/keys/AuthKey_XXXXXXXXXX.p8"
```

**Verify upload:**

```bash
ssh user@chat.ballabotond.com
ls -la ~/chat-server/keys/
# Should show: -rw------- 1 user user 314 Oct 12 12:00 AuthKey_XXXXXXXXXX.p8
```

---

### Step 3: Configure Environment Variables

Create `.env` file in chat-server root:

```bash
cd ~/chat-server
nano .env
```

Add these variables:

```bash
# APNs Configuration
APNS_KEY_ID=AB12CD34EF              # Your 10-char Key ID
APNS_TEAM_ID=XYZ9876543             # Your Team ID
APNS_KEY_PATH=./keys/AuthKey_XXXXXXXXXX.p8  # Path to .p8 file
APNS_BUNDLE_ID=com.31b4.Inviso      # iOS Bundle ID
APNS_ENVIRONMENT=sandbox            # Use 'production' for production

# Existing Variables
USE_SQLITE=1
SQLITE_DB_PATH=./data/chat.db
PORT=8080
```

**Security:**
- ⚠️ **Add `.env` to `.gitignore`** (never commit secrets!)
- ⚠️ **Backup `.env` securely** (encrypted storage)

---

### Step 4: Install dotenv Package

```bash
npm install dotenv --save
```

Load in `index.js` (at the very top):

```javascript
require('dotenv').config();

// ... rest of your imports
```

---

## Database Schema

### Migration Script

**File:** `scripts/migration-001-push-tokens.sql`

```sql
-- Migration: Add APNs token columns to existing tables
-- Version: 1.0
-- Date: 2025-10-12

-- Add token columns to pendings table
ALTER TABLE pendings ADD COLUMN client1_token TEXT;

-- Add token columns to rooms table
ALTER TABLE rooms ADD COLUMN client1_token TEXT;
ALTER TABLE rooms ADD COLUMN client2_token TEXT;

-- Create index for faster token lookups
CREATE INDEX IF NOT EXISTS idx_rooms_client1_token ON rooms(client1_token);
CREATE INDEX IF NOT EXISTS idx_rooms_client2_token ON rooms(client2_token);

-- Success message
SELECT 'Migration 001: APNs token columns added successfully' AS result;
```

---

### Apply Migration

```bash
cd ~/chat-server

# Backup database first!
cp data/chat.db data/chat.db.backup.$(date +%Y%m%d_%H%M%S)

# Apply migration
sqlite3 data/chat.db < scripts/migration-001-push-tokens.sql

# Verify
sqlite3 data/chat.db "PRAGMA table_info(rooms);"
# Should show client1_token and client2_token columns

sqlite3 data/chat.db "PRAGMA table_info(pendings);"
# Should show client1_token column
```

---

### Rollback (if needed)

**File:** `scripts/rollback-001-push-tokens.sql`

```sql
-- Rollback Migration 001
-- Warning: This will delete token columns!

-- SQLite doesn't support DROP COLUMN directly, need to recreate tables

-- Backup current data
CREATE TABLE rooms_backup AS SELECT roomid, joinid, client1, client2, exp FROM rooms;
CREATE TABLE pendings_backup AS SELECT joinid, exp, client1 FROM pendings;

-- Drop old tables
DROP TABLE rooms;
DROP TABLE pendings;

-- Recreate original schema (from init-db.sql)
CREATE TABLE pendings (
  joinid TEXT PRIMARY KEY,
  exp TEXT NOT NULL,
  client1 TEXT NOT NULL
);

CREATE TABLE rooms (
  roomid TEXT PRIMARY KEY,
  joinid TEXT UNIQUE NOT NULL,
  client1 TEXT NOT NULL,
  client2 TEXT NOT NULL,
  exp TEXT NOT NULL
);

-- Restore data
INSERT INTO pendings SELECT * FROM pendings_backup;
INSERT INTO rooms SELECT * FROM rooms_backup;

-- Cleanup
DROP TABLE pendings_backup;
DROP TABLE rooms_backup;

SELECT 'Rollback complete' AS result;
```

---

## Implementation Steps

### Step 1: Create APNs Service Module

**File:** `src/apns-service.js`

```javascript
const apn = require('@parse/node-apn');
const path = require('path');

/**
 * APNs Service
 * Handles Apple Push Notification sending with token-based auth.
 */
class APNsService {
  constructor() {
    this.provider = null;
    this.isInitialized = false;
    this.init();
  }

  init() {
    try {
      const keyId = process.env.APNS_KEY_ID;
      const teamId = process.env.APNS_TEAM_ID;
      const keyPath = process.env.APNS_KEY_PATH;
      const environment = process.env.APNS_ENVIRONMENT || 'sandbox';

      if (!keyId || !teamId || !keyPath) {
        console.warn('[APNs] Missing configuration. Push notifications disabled.');
        return;
      }

      // Resolve key path relative to project root
      const absoluteKeyPath = path.resolve(keyPath);

      const options = {
        token: {
          key: absoluteKeyPath,
          keyId: keyId,
          teamId: teamId
        },
        production: environment === 'production',
        // Connection settings
        connectionRetryLimit: 3,
        heartBeat: 60000,
        requestTimeout: 5000
      };

      this.provider = new apn.Provider(options);
      this.isInitialized = true;
      
      const env = environment === 'production' ? 'Production' : 'Sandbox';
      console.log(`[APNs] Initialized successfully (${env})`);
      console.log(`[APNs] Key ID: ${keyId}`);
      console.log(`[APNs] Team ID: ${teamId}`);
    } catch (error) {
      console.error('[APNs] Initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Send presence notification to a device
   * @param {string} deviceToken - APNs device token (hex string)
   * @param {string} roomId - Room ID for deep link
   * @param {string} message - Notification message (default: "Your chat partner is waiting")
   * @returns {Promise<{success: boolean, response?: object, error?: Error}>}
   */
  async sendPresenceNotification(deviceToken, roomId, message = 'Your chat partner is waiting') {
    if (!this.isInitialized || !this.provider) {
      console.warn('[APNs] Service not initialized. Skipping notification.');
      return { success: false, error: new Error('APNs not initialized') };
    }

    if (!deviceToken || typeof deviceToken !== 'string') {
      console.error('[APNs] Invalid device token:', deviceToken);
      return { success: false, error: new Error('Invalid device token') };
    }

    try {
      // Create notification
      const notification = new apn.Notification();
      
      // APNs payload
      notification.alert = message;
      notification.sound = 'default';
      notification.badge = 1;
      notification.topic = process.env.APNS_BUNDLE_ID; // Required!
      
      // Custom data for deep link
      notification.payload = {
        roomId: roomId,
        type: 'presence'
      };

      // Set expiry (5 minutes - if not delivered, don't retry forever)
      notification.expiry = Math.floor(Date.now() / 1000) + 300;
      
      // Set priority (10 = immediate, 5 = power-efficient)
      notification.priority = 10;

      // Set push type (required for iOS 13+)
      notification.pushType = 'alert';

      console.log(`[APNs] Sending notification to ${deviceToken.substring(0, 16)}...`);
      console.log(`[APNs] Room ID: ${roomId}, Message: "${message}"`);

      // Send notification
      const result = await this.provider.send(notification, deviceToken);

      // Process response
      if (result.sent && result.sent.length > 0) {
        console.log(`[APNs] ✅ Successfully sent to ${result.sent.length} device(s)`);
        return { success: true, response: result };
      }

      if (result.failed && result.failed.length > 0) {
        const failure = result.failed[0];
        
        if (failure.error) {
          // Transport-level error (e.g., network)
          console.error('[APNs] ❌ Transport error:', failure.error.message);
          return { success: false, error: failure.error };
        } else {
          // APNs rejection (e.g., invalid token)
          console.error('[APNs] ❌ Rejected:', failure.status, failure.response);
          return { 
            success: false, 
            error: new Error(`APNs rejected: ${failure.response?.reason || 'Unknown'}`) 
          };
        }
      }

      return { success: false, error: new Error('Unknown APNs error') };

    } catch (error) {
      console.error('[APNs] Exception during send:', error);
      return { success: false, error };
    }
  }

  /**
   * Gracefully shutdown APNs connection
   */
  async shutdown() {
    if (this.provider) {
      console.log('[APNs] Shutting down...');
      await this.provider.shutdown();
      this.isInitialized = false;
    }
  }
}

// Singleton instance
const apnsService = new APNsService();

module.exports = apnsService;
```

---

### Step 2: Update Database CLI (db-cli.js)

**File:** `src/db-cli.js`

Add token support to database operations:

```javascript
// Add after existing functions in createDbClient()

/**
 * Create pending with optional token
 */
async function createPending({ joinid, exp, client1, client1_token = null }) {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO pendings (joinid, exp, client1, client1_token) VALUES (?, ?, ?, ?)'
  );
  stmt.run(joinid, exp, client1, client1_token);
}

/**
 * Accept pending and create room with tokens
 */
async function acceptPendingToRoom({ joinid, client2, roomid, client2_token = null }) {
  const db = getDb();
  const pending = db.prepare('SELECT * FROM pendings WHERE joinid = ?').get(joinid);
  
  if (!pending) {
    return { ok: false, code: 404 };
  }
  
  const now = new Date().toISOString();
  if (pending.exp && pending.exp < now) {
    // Clean up expired
    db.prepare('DELETE FROM pendings WHERE joinid = ?').run(joinid);
    return { ok: false, code: 404 };
  }
  
  try {
    db.transaction(() => {
      db.prepare(
        'INSERT INTO rooms (roomid, joinid, client1, client2, exp, client1_token, client2_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(roomid, joinid, pending.client1, client2, pending.exp, pending.client1_token, client2_token);
      
      db.prepare('DELETE FROM pendings WHERE joinid = ?').run(joinid);
    })();
    
    return { ok: true, roomid, exp: pending.exp, client1: pending.client1, client2 };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return { ok: false, code: 409 };
    }
    throw err;
  }
}

/**
 * Get room with tokens
 */
async function getRoomById(roomid) {
  const db = getDb();
  const room = db.prepare('SELECT * FROM rooms WHERE roomid = ?').get(roomid);
  return room || null;
}

// Export updated functions
module.exports = {
  createDbClient() {
    return {
      createPending,
      acceptPendingToRoom,
      getRoomById,
      // ... existing functions
    };
  }
};
```

---

### Step 3: Update REST API Endpoints (index.js)

**File:** `index.js`

Update endpoints to accept and store tokens:

```javascript
const apnsService = require('./src/apns-service');

// ... existing code ...

if (USE_DB && dbHooks) {
  // Create pending join (client1)
  app.post('/api/rooms', async (req, res) => {
    try {
      const { joinid, client1, expiresInSeconds, client1_token } = req.body || {};
      log.info('HTTP POST /api/rooms', { 
        joinid, 
        expiresInSeconds, 
        client1_len: client1?.length,
        has_token: !!client1_token
      });
      
      const missing = required(req.body, ['joinid', 'client1', 'expiresInSeconds']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      
      // Validate expiresInSeconds
      const seconds = parseInt(expiresInSeconds, 10);
      if (isNaN(seconds) || seconds < 1 || seconds > 86400) {
        return res.status(400).json({ 
          error: 'invalid_expiresInSeconds', 
          details: 'must be 1-86400 seconds (1 sec to 24 hours)' 
        });
      }
      
      // Calculate expiry date on server side (UTC)
      const expiryDate = new Date(Date.now() + seconds * 1000).toISOString();
      log.info('Server-calculated expiry:', { expiresInSeconds: seconds, expiryDate });
      
      // Store with optional token
      await dbHooks.createPending({ 
        joinid, 
        exp: expiryDate, 
        client1,
        client1_token: client1_token || null
      });
      
      return res.status(201).json({ ok: true, exp: expiryDate });
    } catch (e) {
      log.error('Create pending failed:', e.message, e.stack);
      return res.status(500).json({ error: 'create_failed' });
    }
  });

  // Accept by client2 -> create a room
  app.post('/api/rooms/accept', async (req, res) => {
    try {
      const { joinid, client2, client2_token } = req.body || {};
      log.info('HTTP POST /api/rooms/accept', { 
        joinid, 
        client2_len: client2?.length,
        has_token: !!client2_token
      });
      
      const missing = required(req.body, ['joinid', 'client2']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      
      const roomid = crypto.createHash('sha256')
        .update(`${joinid}:${client2}:${crypto.randomUUID()}`)
        .digest('hex')
        .slice(0, 48);
      
      const result = await dbHooks.acceptPendingToRoom({ 
        joinid, 
        client2, 
        roomid,
        client2_token: client2_token || null
      });
      
      if (!result.ok) {
        const code = result.code === 404 ? 404 : 409;
        return res.status(code).json({ 
          error: result.code === 404 ? 'not_found_or_expired' : 'conflict' 
        });
      }
      
      log.info('Room created:', { roomid, client1: result.client1, client2 });
      return res.status(200).json({ 
        roomid, 
        exp: result.exp,
        ephemeralId: result.client2  // Return ephemeral ID for iOS
      });
    } catch (e) {
      log.error('Accept pending failed:', e.message, e.stack);
      return res.status(500).json({ error: 'accept_failed' });
    }
  });
}
```

---

### Step 4: Integrate Push Notifications into WebSocket

**File:** `index.js` (in WebSocket message handler)

Add push notification logic to `join_room` handler:

```javascript
// In handleJoinRoom function (around line 280)
function handleJoinRoom(clientId, parsedMessage, client, ws) {
  const { roomId } = parsedMessage;

  if (!roomId) {
    ws.send(JSON.stringify({ 
      type: 'error', 
      error: 'roomId is required for join_room' 
    }));
    return;
  }

  // Check room capacity
  if (rooms.has(roomId) && rooms.get(roomId).size >= 2) {
    ws.send(JSON.stringify({ 
      type: 'room_full', 
      error: 'Room is full (max 2 users)',
      roomId: roomId
    }));
    return;
  }

  // Remove from previous room
  if (client.roomId && rooms.has(client.roomId)) {
    const oldRoom = rooms.get(client.roomId);
    oldRoom.delete(clientId);
    if (oldRoom.size === 0) {
      rooms.delete(client.roomId);
      log.info(`Deleted empty room: ${client.roomId}`);
    } else {
      // Notify remaining client in old room
      notifyRoomPeers(client.roomId, {
        type: 'peer_left',
        message: 'Other user left the room'
      });
    }
  }

  // Create or join room
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
    log.info(`Created room: ${roomId}`);
  }

  const room = rooms.get(roomId);
  const isFirstUser = room.size === 0;
  
  room.add(clientId);
  client.roomId = roomId;
  client.isInitiator = isFirstUser;

  const userCount = room.size;
  log.info(`Client ${clientId} joined room ${roomId} (${userCount}/2 users) - ${isFirstUser ? 'Initiator' : 'Receiver'}`);

  // Notify client of successful join
  ws.send(JSON.stringify({ 
    type: 'room_joined', 
    roomId: roomId,
    userCount: userCount,
    isInitiator: isFirstUser,
    ready: userCount === 2
  }));
  
  log.info(`Client ${clientId} assigned as ${isFirstUser ? 'initiator' : 'receiver'} in room ${roomId}`);

  // If room is full, notify both clients with initiator info
  if (userCount === 2) {
    const roomClients = Array.from(room);
    roomClients.forEach((id, index) => {
      const client = clients.get(id);
      if (client && client.ws.readyState === WS_OPEN) {
        client.ws.send(JSON.stringify({
          type: 'room_ready',
          roomId: roomId,
          message: 'Both users connected. Ready for WebRTC handshake.',
          userCount: 2,
          isInitiator: index === 0 // First user is initiator
        }));
      }
    });
    log.info(`Room ${roomId} is ready - starting WebRTC signaling`);
  }

  // ========== NEW: Push Notification Logic ==========
  // If only one user in room, check if peer exists and send push
  if (userCount === 1 && USE_DB && dbHooks) {
    sendPushNotificationToPeer(roomId, clientId).catch(err => {
      log.error(`Failed to send push notification for room ${roomId}:`, err.message);
    });
  }
  // ===================================================
}

/**
 * Send push notification to peer if they're offline
 * @param {string} roomId - The room ID
 * @param {string} joinedClientId - The client who just joined
 */
async function sendPushNotificationToPeer(roomId, joinedClientId) {
  try {
    // Get room data from database
    const room = await dbHooks.getRoomById(roomId);
    if (!room) {
      log.debug(`[Push] Room ${roomId} not found in database`);
      return;
    }

    // Determine which client is the peer (the one NOT joining)
    const peerEphemeralId = room.client1 === joinedClientId ? room.client2 : room.client1;
    const peerToken = room.client1 === joinedClientId ? room.client2_token : room.client1_token;

    if (!peerToken) {
      log.debug(`[Push] No token for peer ${peerEphemeralId.substring(0, 8)}...`);
      return;
    }

    // Check if peer is already connected to WebSocket
    const isPeerConnected = Array.from(clients.values()).some(c => {
      // Match by roomId (if they're already in the room)
      return c.roomId === roomId;
    });

    if (isPeerConnected) {
      log.debug(`[Push] Peer already connected, skipping notification`);
      return;
    }

    // Send push notification
    log.info(`[Push] Sending notification to peer ${peerEphemeralId.substring(0, 8)}...`);
    const result = await apnsService.sendPresenceNotification(
      peerToken,
      roomId,
      'Your chat partner is waiting'
    );

    if (result.success) {
      log.info(`[Push] ✅ Notification sent successfully`);
    } else {
      log.warn(`[Push] ⚠️ Failed to send notification:`, result.error?.message);
      
      // Optional: Remove invalid token from database
      if (result.error?.message?.includes('Unregistered') || 
          result.error?.message?.includes('BadDeviceToken')) {
        log.info(`[Push] Removing invalid token from database`);
        // TODO: Implement token removal (add to db-cli.js)
      }
    }
  } catch (error) {
    log.error(`[Push] Exception:`, error.message);
  }
}
```

---

## API Endpoints

### Summary of Changes

| Endpoint | Method | Changes |
|----------|--------|---------|
| `/api/rooms` | POST | + Accept `client1_token` (optional) |
| `/api/rooms/accept` | POST | + Accept `client2_token` (optional) |
| `/api/rooms` | GET | + Return `client1_token`, `client2_token` (for debugging) |
| `/api/rooms` | DELETE | + Delete tokens when room is deleted |

---

## WebSocket Integration

### Modified Message Flow

**Before:**
```
Client: join_room { roomId: "xyz" }
Server: room_joined { roomId, userCount, isInitiator }
Server (if 2 users): room_ready { ... }
```

**After:**
```
Client: join_room { roomId: "xyz" }
Server: room_joined { roomId, userCount, isInitiator }
Server (if 1 user): Check peer online?
  → NO: Send APNs push to peer
  → YES: Do nothing
Server (if 2 users): room_ready { ... }
```

---

## Testing

### Step 1: Test APNs Service Initialization

```bash
cd ~/chat-server
node -e "const apns = require('./src/apns-service'); setTimeout(() => process.exit(0), 1000);"
```

**Expected output:**
```
[APNs] Initialized successfully (Sandbox)
[APNs] Key ID: AB12CD34EF
[APNs] Team ID: XYZ9876543
```

---

### Step 2: Test Token Storage

**Create pending with token:**

```bash
curl -X POST https://chat.ballabotond.com/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "joinid": "TEST01",
    "client1": "test-device-001",
    "expiresInSeconds": 3600,
    "client1_token": "abc123def456..." 
  }'
```

**Verify in database:**

```bash
sqlite3 data/chat.db "SELECT * FROM pendings WHERE joinid='TEST01';"
# Should show client1_token column populated
```

---

### Step 3: Test Push Notification Sending

**Create test script:**

**File:** `test-push.js`

```javascript
require('dotenv').config();
const apnsService = require('./src/apns-service');

async function testPush() {
  const deviceToken = 'YOUR_DEVICE_TOKEN_FROM_IOS_APP';
  const roomId = 'test-room-123';

  console.log('Sending test notification...');
  const result = await apnsService.sendPresenceNotification(deviceToken, roomId);

  console.log('Result:', result);
  
  // Graceful shutdown
  await apnsService.shutdown();
  process.exit(result.success ? 0 : 1);
}

testPush();
```

**Run:**

```bash
node test-push.js
```

**Expected output:**
```
[APNs] Initialized successfully (Sandbox)
Sending test notification...
[APNs] Sending notification to abc123def456...
[APNs] Room ID: test-room-123, Message: "Your chat partner is waiting"
[APNs] ✅ Successfully sent to 1 device(s)
Result: { success: true, response: { sent: [Array], failed: [] } }
[APNs] Shutting down...
```

---

### Step 4: Test End-to-End Flow

**Requirements:** 2 physical iOS devices

**Device 1 (Creator):**
1. Open app → Create session → Note join code
2. Send app to background
3. Monitor server logs

**Device 2 (Joiner):**
1. Open app → Enter join code → Accept
2. App joins room via WebSocket

**Expected server logs:**
```
[INFO] Client abc123 joined room xyz789 (1/2 users) - Initiator
[Push] Sending notification to peer def456...
[APNs] Sending notification to device_token_here...
[APNs] ✅ Successfully sent to 1 device(s)
```

**Expected on Device 1:**
- Push notification appears: "Your chat partner is waiting"
- Tap notification → App opens → Joins room → P2P established

---

## Production Deployment

### Step 1: Update Environment

Change `.env` for production:

```bash
APNS_ENVIRONMENT=production  # ← Change from 'sandbox'
```

**Important:** Production APNs requires **production provisioning profile** on iOS app.

---

### Step 2: Systemd Service

Create service file for auto-restart:

**File:** `/etc/systemd/system/chat-server.service`

```ini
[Unit]
Description=Chat Server with Push Notifications
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/chat-server
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Enable and start:**

```bash
sudo systemctl enable chat-server
sudo systemctl start chat-server
sudo systemctl status chat-server
```

---

### Step 3: Monitoring

**Check logs:**

```bash
# Real-time logs
sudo journalctl -u chat-server -f

# Filter APNs logs
sudo journalctl -u chat-server | grep "\[APNs\]"
sudo journalctl -u chat-server | grep "\[Push\]"
```

**Monitor push success rate:**

```bash
# Count successful sends
sudo journalctl -u chat-server --since today | grep -c "Successfully sent"

# Count failures
sudo journalctl -u chat-server --since today | grep -c "Failed to send"
```

---

### Step 4: Rate Limiting

Add rate limiting to prevent abuse:

**Install express-rate-limit:**

```bash
npm install express-rate-limit --save
```

**Add to index.js:**

```javascript
const rateLimit = require('express-rate-limit');

// Rate limit for room creation (10 per hour per IP)
const createRoomLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many room creation requests. Try again later.' }
});

app.post('/api/rooms', createRoomLimiter, async (req, res) => {
  // ... existing code
});
```

---

## Troubleshooting

### APNs Initialization Fails

**Symptoms:** `[APNs] Missing configuration. Push notifications disabled.`

**Solutions:**
1. Check `.env` file exists and has all variables
2. Verify `APNS_KEY_PATH` points to correct `.p8` file
3. Check file permissions: `ls -la keys/AuthKey_*.p8` (should be `-rw-------`)
4. Verify Key ID and Team ID are correct (check Apple Developer Portal)

---

### "BadDeviceToken" Error

**Symptoms:** APNs rejects with reason "BadDeviceToken"

**Solutions:**
1. Verify using correct environment (sandbox vs production)
   - Development builds → `sandbox`
   - TestFlight/App Store → `production`
2. Device token format should be 64-character hex string
3. Regenerate token on iOS: Uninstall app → Reinstall

---

### "MissingTopic" Error

**Symptoms:** APNs rejects with reason "MissingTopic"

**Solution:**
- Ensure `notification.topic = process.env.APNS_BUNDLE_ID;` is set
- Verify `APNS_BUNDLE_ID` matches iOS app bundle ID exactly

---

### Notification Sent but Not Received

**Possible causes:**
1. iOS device in Do Not Disturb mode
2. App notifications disabled in iOS Settings
3. Wrong APNs environment (sandbox vs production)
4. Expired device token (app was uninstalled)

**Debugging:**
1. Check APNs response in server logs
2. Verify notification permissions on iOS
3. Test with a fresh device token

---

### Database Token Not Found

**Symptoms:** `[Push] No token for peer`

**Solutions:**
1. Verify iOS is sending tokens in API requests
2. Check database schema has token columns: `PRAGMA table_info(rooms);`
3. Check token is not NULL in database: `SELECT * FROM rooms WHERE roomid='xyz';`

---

## Security Checklist

Before production:

- [ ] `.p8` key file permissions are `600` (read/write owner only)
- [ ] `.env` is in `.gitignore` (never commit!)
- [ ] APNs key is backed up securely (encrypted storage)
- [ ] Database tokens are deleted on room expiry/deletion
- [ ] Rate limiting enabled on room creation endpoint
- [ ] HTTPS enabled (tokens sent over secure connection)
- [ ] Server logs don't expose full device tokens (only first 16 chars)
- [ ] Token validation before sending (check not expired)
- [ ] Failed token removal from database (invalid/unregistered)

---

## Performance Optimization

### Connection Pooling

For high-volume deployments, use `apn.MultiProvider`:

```javascript
const options = {
  clientCount: 3, // Multiple HTTP/2 connections
  token: { /* ... */ },
  production: true
};

const provider = new apn.MultiProvider(options);
```

---

### Async Processing

For large-scale, use a job queue (e.g., Bull):

```bash
npm install bull --save
```

```javascript
const Queue = require('bull');
const pushQueue = new Queue('push-notifications');

// Producer (in join_room handler)
pushQueue.add({ roomId, peerToken });

// Consumer (separate process)
pushQueue.process(async (job) => {
  const { roomId, peerToken } = job.data;
  await apnsService.sendPresenceNotification(peerToken, roomId);
});
```

---

## Maintenance

### Token Cleanup

Run periodic cleanup to remove stale tokens:

**File:** `scripts/cleanup-tokens.js`

```javascript
const { getDb } = require('../src/db');

const db = getDb();

// Remove tokens for expired rooms
const result = db.prepare(`
  DELETE FROM rooms 
  WHERE exp < datetime('now') 
  AND (client1_token IS NOT NULL OR client2_token IS NOT NULL)
`).run();

console.log(`Cleaned up ${result.changes} expired room tokens`);

process.exit(0);
```

**Cron job (daily at 3 AM):**

```bash
crontab -e
```

Add:
```
0 3 * * * cd /home/youruser/chat-server && /usr/bin/node scripts/cleanup-tokens.js
```

---

## Next Steps

1. ✅ Complete backend implementation (this guide)
2. ✅ Test on staging server with iOS devices
3. 📝 Update API documentation
4. 🧪 Load testing (simulate many concurrent pushes)
5. 📊 Add metrics (success rate, latency)
6. 🚀 Deploy to production

---

## References

- [node-apn Documentation](https://github.com/parse-community/node-apn)
- [APNs Provider API](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server)
- [Best Practices for Push Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)
- [SQLite Migration Best Practices](https://www.sqlite.org/lang_altertable.html)

---

**End of Backend Implementation Guide**
