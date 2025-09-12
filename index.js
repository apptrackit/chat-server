// WebRTC P2P Signaling Server for iOS App

const express = require('express');
const { Server } = require('ws');
const crypto = require('crypto');

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

// CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/', (req, res) => {
  log.info('Health check from', req.ip);
  res.send('WebRTC P2P Signaling Server Active - Ready for iOS clients');
});

// Get room info endpoint
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
  log.info('Ready for iOS WebRTC connections via WSS');
});

const wss = new Server({ server });

// Store connected clients and rooms
const clients = new Map(); // clientId -> { ws, roomId, isInitiator }
const rooms = new Map();   // roomId -> Set of clientIds

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  log.info(`iOS client connected: ${clientId}`, 'IP:', req.socket?.remoteAddress || 'unknown');

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

  // If room is full, notify both clients
  if (userCount === 2) {
    notifyRoomPeers(roomId, {
      type: 'room_ready',
      roomId: roomId,
      message: 'Both users connected. Ready for WebRTC handshake.',
      userCount: 2
    });
    log.info(`Room ${roomId} is ready - starting WebRTC signaling`);
  }
}

function handleWebRTCSignaling(clientId, message, client, signalType) {
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
  if (!otherClient || otherClient.ws.readyState !== 1) { // 1 = OPEN
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

function handleClientDisconnect(clientId, code, reason) {
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
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  room.forEach(clientId => {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === 1) { // OPEN
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

log.info('WebRTC P2P Signaling Server initialized and ready for iOS clients');
