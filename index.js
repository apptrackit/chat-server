// WebRTC P2P Signaling Server
// Purpose: Room-based signaling for WebRTC peers (mobile/web). Handles join/leave, offer/answer, and ICE.

const express = require('express');
const { Server } = require('ws');
const crypto = require('crypto');
const USE_DB = process.env.USE_SQLITE === '1' || process.env.USE_SQLITE === 'true';
let dbHooks;
if (USE_DB) {
  try {
    dbHooks = require('./src/db-cli').createDbClient();
    console.log('[DB] SQLite hooks enabled');
  } catch (e) {
    console.warn('[DB] hooks unavailable:', e.message);
  }
}

// Enhanced logging utility
const COLORS = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[35m',
};

function getTime() {
  return new Date().toISOString();
}

const log = {
  info: (...args) => console.log(`${COLORS.info}[INFO] [${getTime()}]`, ...args, COLORS.reset),
  warn: (...args) => console.warn(`${COLORS.warn}[WARN] [${getTime()}]`, ...args, COLORS.reset),
  error: (...args) => console.error(`${COLORS.error}[ERROR] [${getTime()}]`, ...args, COLORS.reset),
  debug: (...args) => console.debug(`${COLORS.debug}[DEBUG] [${getTime()}]`, ...args, COLORS.reset),
};

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

// CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  log.info('Health check from', req.ip);
  res.send('WebRTC P2P Signaling Server Active - Ready for iOS clients');
});

// --- REST: New room lifecycle backed by SQLite ---
function required(body, fields) {
  for (const f of fields) if (!body || body[f] == null || body[f] === '') return f;
  return null;
}

if (USE_DB && dbHooks) {
  // Purge all data for device ID(s) - supports both array and single ID
  app.post('/api/user/purge', async (req, res) => {
    try {
      const body = req.body || {};
      let deviceIds = [];
      
      // Support new format (array) - preferred
      if (body.deviceIds && Array.isArray(body.deviceIds)) {
        deviceIds = body.deviceIds;
        log.info('HTTP POST /api/user/purge (batch)', { deviceIds_count: deviceIds.length });
      }
      // Support old format (single) - backward compatibility
      else if (body.deviceId && typeof body.deviceId === 'string') {
        deviceIds = [body.deviceId];
        log.info('HTTP POST /api/user/purge (single)', { deviceId_len: body.deviceId.length });
      }
      else {
        return res.status(400).json({ error: 'missing_deviceIds_or_deviceId' });
      }
      
      // Validate array is not empty
      if (deviceIds.length === 0) {
        return res.status(400).json({ error: 'empty_deviceIds_array' });
      }
      
      // Validate IDs are non-empty strings
      const invalidIds = deviceIds.filter(id => !id || typeof id !== 'string' || id.trim().length === 0);
      if (invalidIds.length > 0) {
        return res.status(400).json({ error: 'invalid_device_ids', count: invalidIds.length });
      }
      
      const result = await dbHooks.purgeByDevice(deviceIds);
      log.info('Purge completed', { 
        deviceIdCount: result.deviceIdCount,
        roomsDeleted: result.roomsDeleted, 
        pendingsDeleted: result.pendingsDeleted 
      });
      
      return res.status(200).json({ 
        success: true, 
        deviceIdCount: result.deviceIdCount,
        roomsDeleted: result.roomsDeleted, 
        pendingsDeleted: result.pendingsDeleted 
      });
    } catch (e) {
      log.error('User purge failed:', e.message, e.stack);
      return res.status(500).json({ error: 'purge_failed', details: e.message });
    }
  });

  // Create pending join (client1)
  app.post('/api/rooms', async (req, res) => {
    try {
      const { joinid, client1, expiresInSeconds } = req.body || {};
      log.info('HTTP POST /api/rooms', { joinid, expiresInSeconds, client1_len: client1?.length });
      const missing = required(req.body, ['joinid', 'client1', 'expiresInSeconds']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      
      // Validate expiresInSeconds
      const seconds = parseInt(expiresInSeconds, 10);
      if (isNaN(seconds) || seconds < 1 || seconds > 86400) {
        return res.status(400).json({ error: 'invalid_expiresInSeconds', details: 'must be 1-86400 seconds (1 sec to 24 hours)' });
      }
      
      // Calculate expiry date on server side (UTC)
      const expiryDate = new Date(Date.now() + seconds * 1000).toISOString();
      log.info('Server-calculated expiry:', { expiresInSeconds: seconds, expiryDate });
      
      await dbHooks.createPending({ joinid, exp: expiryDate, client1 });
      return res.status(201).json({ ok: true, exp: expiryDate });
    } catch (e) {
      log.error('Create pending failed:', e.message, e.stack);
      return res.status(500).json({ error: 'create_failed' });
    }
  });

  // Accept by client2 -> create a room
  app.post('/api/rooms/accept', async (req, res) => {
    try {
      const { joinid, client2 } = req.body || {};
      log.info('HTTP POST /api/rooms/accept', { joinid, client2_len: client2?.length });
      const missing = required(req.body, ['joinid', 'client2']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      const roomid = crypto.createHash('sha256').update(`${joinid}:${client2}:${crypto.randomUUID()}`).digest('hex').slice(0, 48);
      const result = await dbHooks.acceptPendingToRoom({ joinid, client2, roomid });
      if (!result.ok) {
        const code = result.code === 404 ? 404 : 409;
        return res.status(code).json({ error: result.code === 404 ? 'not_found_or_expired' : 'conflict' });
      }
      return res.status(200).json({ roomid });
    } catch (e) {
      log.error('Accept room failed:', e.message, e.stack);
      return res.status(500).json({ error: 'accept_failed' });
    }
  });

  // Client1 check if accepted
  app.post('/api/rooms/check', async (req, res) => {
    try {
      const { joinid, client1 } = req.body || {};
      log.info('HTTP POST /api/rooms/check', { joinid, client1_len: client1?.length });
      const missing = required(req.body, ['joinid', 'client1']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      const status = await dbHooks.checkPending({ joinid, client1 });
      if (status.status === 'not_found') return res.status(404).json({ error: 'not_found_or_expired' });
      if (status.status === 'pending') return res.status(204).send();
      // status.ready -> clean up pending row now that client1 has roomid
      try { await dbHooks.deletePending(joinid, client1); } catch (_) { /* non-fatal */ }
      return res.status(200).json({ roomid: status.roomid });
    } catch (e) {
      log.error('Check room failed:', e.message, e.stack);
      return res.status(500).json({ error: 'check_failed' });
    }
  });

  // Delete a room
  app.delete('/api/rooms', async (req, res) => {
    try {
      const { roomid } = req.body || {};
      log.info('HTTP DELETE /api/rooms', { roomid });
      const missing = required(req.body, ['roomid']);
      if (missing) return res.status(400).json({ error: `missing_${missing}` });
      // idempotent delete
      await dbHooks.deleteRoom(roomid);
      return res.sendStatus(200);
    } catch (e) {
      log.error('Delete room failed:', e.message, e.stack);
      return res.status(500).json({ error: 'delete_failed' });
    }
  });

  // Get room by id
  app.get('/api/rooms', async (req, res) => {
    try {
      const roomid = req.query.roomid || req.body?.roomid; // allow either for convenience
      log.info('HTTP GET /api/rooms', { roomid });
      if (!roomid) return res.status(400).json({ error: 'missing_roomid' });
      const room = await dbHooks.getRoomById(roomid);
      if (!room) return res.sendStatus(404);
      return res.status(200).json(room);
    } catch (e) {
      log.error('Get room failed:', e.message, e.stack);
      return res.status(500).json({ error: 'get_failed' });
    }
  });
}

// Legacy endpoints from previous iteration -> 410 to steer away
app.post('/api/rooms/:roomid/accept', (req, res) => res.status(410).json({ error: 'use_new_endpoints' }));
app.get('/api/rooms/:roomid', (req, res) => res.status(410).json({ error: 'use_new_endpoints' }));

// Get room info endpoint for in-memory WS rooms
app.get('/rooms', (req, res) => {
  const roomInfo = Array.from(rooms.entries()).map(([roomId, clients]) => ({
    roomId,
    userCount: clients.size,
    full: clients.size >= 2
  }));
  res.json({ rooms: roomInfo, totalRooms: rooms.size });
});

const server = app.listen(PORT, () => {
  log.info(`WebRTC Signaling Server listening on port ${PORT}`);
  log.info('Ready for WebRTC connections via WSS');
  if (USE_DB && dbHooks) {
    log.info('SQLite automatic cleanup enabled: expired pendings removed via trigger on INSERT');
  }
});

const wss = new Server({ server });

// Store connected clients and rooms
// clients: clientId -> { ws, roomId, isInitiator }
// rooms:   roomId   -> Set<clientId>
const clients = new Map();
const rooms = new Map();

// WebSocket readyState constant for readability
const WS_OPEN = 1;

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  log.info(`Client connected: ${clientId}`, 'IP:', req.socket?.remoteAddress || 'unknown');

  clients.set(clientId, { ws, roomId: null, isInitiator: false });
  
  // Send client their ID
  ws.send(JSON.stringify({ 
    type: 'connected', 
    clientId: clientId,
    server: 'WebRTC P2P Signaling Server'
  }));

  ws.on('message', (message) => {
    let parsedMessage;
    
    try {
      parsedMessage = JSON.parse(message);
      log.debug(`Message from ${clientId}: ${parsedMessage.type}`);
    } catch (error) {
      log.error('Invalid JSON from', clientId, ':', error.message);
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON format' }));
      return;
    }

    const client = clients.get(clientId);
    if (!client) {
      log.error(`Client ${clientId} not found`);
      return;
    }

    switch (parsedMessage.type) {
      case 'join_room': {
        handleJoinRoom(clientId, parsedMessage, client, ws);
        break;
      }

      case 'leave_room': {
        handleLeaveRoom(clientId, client, ws);
        break;
      }

      case 'webrtc_offer': {
        handleWebRTCSignaling(clientId, parsedMessage, client, 'offer');
        break;
      }

      case 'webrtc_answer': {
        handleWebRTCSignaling(clientId, parsedMessage, client, 'answer');
        break;
      }

      case 'ice_candidate': {
        handleWebRTCSignaling(clientId, parsedMessage, client, 'ice');
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }

      default:
        log.warn(`Unknown message type from ${clientId}: ${parsedMessage.type}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: `Unknown message type: ${parsedMessage.type}` 
        }));
    }
  });

  ws.on('close', (code, reason) => {
    handleClientDisconnect(clientId, code, reason);
  });

  ws.on('error', (error) => {
    log.error(`WebSocket error for ${clientId}:`, error.message);
  });
});

function handleJoinRoom(clientId, message, client, ws) {
  /**
   * Add client to a room (creating it if needed). First client becomes initiator.
   * Notifies when room is ready (2 users) with initiator flag so only one creates an offer.
   */
  const { roomId } = message;
  
  if (!roomId || typeof roomId !== 'string') {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid roomId' }));
    return;
  }

  // Check if room is full
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
    // DB not used for WS rooms
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
      if (client && client.ws.readyState === WS_OPEN) { // OPEN
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
}

function handleWebRTCSignaling(clientId, message, client, signalType) {
  /**
   * Forwards offer/answer/ice messages to the peer in the same room.
   * Ensures exactly two users are present and the peer is available.
   */
  const { roomId } = client;
  
  if (!roomId || !rooms.has(roomId)) {
    client.ws.send(JSON.stringify({ 
      type: 'error', 
      error: 'Not in a valid room for WebRTC signaling' 
    }));
    return;
  }

  const room = rooms.get(roomId);
  if (room.size !== 2) {
    client.ws.send(JSON.stringify({ 
      type: 'error', 
      error: 'Room must have exactly 2 users for WebRTC' 
    }));
    return;
  }

  // Find the other client in the room
  const otherClientId = Array.from(room).find(id => id !== clientId);
  
  if (!otherClientId) {
    log.warn(`No peer found in room ${roomId} for ${signalType}`);
    return;
  }

  const otherClient = clients.get(otherClientId);
  if (!otherClient || otherClient.ws.readyState !== WS_OPEN) { // OPEN
    log.warn(`Peer ${otherClientId} not available for ${signalType}`);
    return;
  }

  // Forward the signaling message
  const forwardMessage = {
    type: message.type,
    from: clientId,
    roomId: roomId
  };

  // Include the specific data based on signal type
  if (signalType === 'offer' || signalType === 'answer') {
    forwardMessage.sdp = message.sdp;
  } else if (signalType === 'ice') {
    forwardMessage.candidate = message.candidate;
  }

  otherClient.ws.send(JSON.stringify(forwardMessage));
  log.info(`Forwarded ${signalType} from ${clientId} to ${otherClientId} in room ${roomId}`);
}

function handleLeaveRoom(clientId, client, ws) {
  /**
   * Removes the client from its current room, notifies the remaining peer,
   * deletes the room if empty, and confirms to the leaver.
   */
  const { roomId } = client;
  if (!roomId || !rooms.has(roomId)) {
    ws.send(JSON.stringify({ type: 'left_room', roomId: null }));
    return;
  }

  const room = rooms.get(roomId);
  room.delete(clientId);

  // Notify remaining peers in the room
  notifyRoomPeers(roomId, {
    type: 'peer_left',
    message: 'Other user left the room'
  });

  // Clean up empty room
  if (room.size === 0) {
    rooms.delete(roomId);
    log.info(`Deleted empty room: ${roomId}`);
  }

  // Clear client's room association
  client.roomId = null;
  client.isInitiator = false;

  // Confirm to leaver
  ws.send(JSON.stringify({ type: 'left_room', roomId }));
  log.info(`Client ${clientId} left room ${roomId}`);
}

function handleClientDisconnect(clientId, code, reason) {
  /**
   * Cleanup when a client connection closes. Removes from room, notifies peer,
   * and deletes the room if it becomes empty.
   */
  log.info(`Client ${clientId} disconnected - Code: ${code}, Reason: ${reason?.toString() || 'none'}`);
  
  const client = clients.get(clientId);
  if (client && client.roomId && rooms.has(client.roomId)) {
    const roomId = client.roomId;
    const room = rooms.get(roomId);
    room.delete(clientId);
    
    // Notify remaining peer
    if (room.size > 0) {
      notifyRoomPeers(roomId, {
        type: 'peer_disconnected',
        message: 'Other user disconnected'
      });
    }
    
    // Clean up empty room
    if (room.size === 0) {
      rooms.delete(roomId);
      log.info(`Deleted empty room: ${roomId}`);
    }
  }
  
  clients.delete(clientId);
}

function notifyRoomPeers(roomId, message) {
  /**
   * Broadcast a message to all clients currently in a room.
   */
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  room.forEach(clientId => {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WS_OPEN) { // OPEN
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Periodic cleanup of stale connections
setInterval(() => {
  const staleClients = [];
  
  clients.forEach((client, clientId) => {
    if (client.ws.readyState !== 1) { // Not OPEN
      staleClients.push(clientId);
    }
  });
  
  staleClients.forEach(clientId => {
    handleClientDisconnect(clientId, 1006, 'Stale connection cleanup');
  });
  
  if (staleClients.length > 0) {
    log.info(`Cleaned up ${staleClients.length} stale connections`);
  }
}, 60000); // Every minute

// Periodic cleanup of expired pendings
if (USE_DB && dbHooks?.cleanupExpired) {
  setInterval(async () => {
    try {
      const deleted = await dbHooks.cleanupExpired();
      if (deleted > 0) log.info(`Cleaned up ${deleted} expired pendings`);
    } catch (e) {
      log.warn('Expired cleanup failed:', e.message);
    }
  }, 60000);
}

log.info('WebRTC P2P Signaling Server initialized and ready for clients');
