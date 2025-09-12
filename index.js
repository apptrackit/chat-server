// server.js

// 1. Import necessary libraries
// 'express' for creating the HTTP server
// 'ws' for WebSocket communication
const express = require('express');
const { Server } = require('ws');

// Enhanced logging utility with color coding
const COLORS = {
  reset: '\x1b[0m',
  info: '\x1b[36m',      // Cyan
  warn: '\x1b[33m',      // Yellow
  error: '\x1b[31m',     // Red
  debug: '\x1b[35m',     // Magenta
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

// 2. Server Setup

const PORT = process.env.PORT || 8080;
const app = express();

// Use a basic route for health checks or info

app.get('/', (req, res) => {
  log.info('Health check route hit from', req.ip);
  res.send('WebRTC P2P Signaling Server is active.');
});

// Create an HTTP server from the Express app

const server = app.listen(PORT, () => {
  log.info(`Server is listening on port: ${PORT}`);
});

// 3. WebSocket Server Initialization
// Attach the WebSocket server to the HTTP server

const wss = new Server({ server });
log.info('WebSocket server initialized.');

// 4. In-memory data structure to store rooms and clients
// A Map is used where:
// key = roomId (string)
// value = a Set of connected WebSocket clients in that room

const rooms = new Map();

// 5. WebSocket Connection Handling
// WebSocket connection handler
wss.on('connection', (ws, req) => {
  log.info('New client connected.', 'IP:', req.socket?.remoteAddress || 'unknown');

  // This variable will be set when the client joins a room
  let currentRoomId = null;

  // 6. Handle incoming messages from clients
  ws.on('message', (message) => {
    log.debug('Received message:', message);
    let parsedMessage;
    try {
      // Messages are expected to be in JSON format
      parsedMessage = JSON.parse(message);
    } catch (error) {
      log.error('Failed to parse message:', message, error);
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON format' }));
      return;
    }

    // Use a switch statement to handle different message types
    switch (parsedMessage.type) {
      // A. Case for when a client wants to join a room
      case 'join_room': {
        const { roomId } = parsedMessage.payload || {};
        if (!roomId) {
          log.warn('join_room message missing roomId:', parsedMessage);
          ws.send(JSON.stringify({ type: 'error', error: 'Missing roomId in join_room' }));
          break;
        }
        
        // Check if room exists and is already full (2 users max)
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId);
          if (room.size >= 2) {
            log.warn(`Room ${roomId} is full (${room.size} users). Rejecting new client.`);
            ws.send(JSON.stringify({ 
              type: 'error', 
              error: 'Room is full. Maximum 2 users per room.' 
            }));
            break;
          }
        }
        
        currentRoomId = roomId; // Store the room ID for this connection

        // If the room doesn't exist, create it
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
          log.info(`Created new room: ${roomId}`);
        }

        // Add the client to the specified room
        rooms.get(roomId).add(ws);
        const roomSize = rooms.get(roomId).size;
        log.info(`Client joined room: ${roomId} (${roomSize}/2 users)`);
        
        // Notify client of successful join with room status
        ws.send(JSON.stringify({ 
          type: 'joined_room', 
          roomId,
          userCount: roomSize,
          canSendMessages: roomSize === 2
        }));
        
        // If room is now full (2 users), notify both users that WebRTC setup can begin
        if (roomSize === 2) {
          const room = rooms.get(roomId);
          room.forEach(client => {
            if (client.readyState === client.OPEN) {
              client.send(JSON.stringify({
                type: 'room_ready',
                roomId,
                message: 'Both users connected. Establishing peer-to-peer connection...'
              }));
            }
          });
          log.info(`Room ${roomId} is ready for WebRTC connection with 2 users.`);
        } else {
          // Notify the user they're waiting for another user
          ws.send(JSON.stringify({
            type: 'waiting_for_user',
            roomId,
            message: 'Waiting for another user to join...'
          }));
        }
        break;
      }

      // B. Cases for WebRTC signaling messages (offer, answer, candidate)
      // These messages are simply broadcasted to other clients in the same room.
      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        if (!currentRoomId) {
          log.warn(`Received signaling message (${parsedMessage.type}) before joining a room.`);
          ws.send(JSON.stringify({ type: 'error', error: 'Join a room before sending signaling messages.' }));
          break;
        }
        
        const room = rooms.get(currentRoomId);
        if (!room) {
          log.warn(`Tried to send signaling message but room not found:`, currentRoomId);
          ws.send(JSON.stringify({ type: 'error', error: 'Room not found.' }));
          break;
        }
        
        // Check if room has exactly 2 users for WebRTC signaling
        if (room.size !== 2) {
          log.warn(`Signaling rejected: Room ${currentRoomId} has ${room.size} users, need exactly 2.`);
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: 'Cannot establish WebRTC connection. Room must have exactly 2 users.' 
          }));
          break;
        }
        
        let relayedCount = 0;
        // Broadcast the message to every other client in the room
        room.forEach(client => {
          // Check if the client is not the sender and is ready to receive messages
          if (client !== ws && client.readyState === ws.OPEN) {
            client.send(JSON.stringify(parsedMessage));
            relayedCount++;
          }
        });
        // Log the action for debugging
        log.info(`Relayed '${parsedMessage.type}' in room: ${currentRoomId} to ${relayedCount} client(s).`);
        break;
      }

      // C. Default case for unknown message types
      default:
        log.warn('Unknown message type received:', parsedMessage.type, parsedMessage);
        ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${parsedMessage.type}` }));
    }
  });

  // 7. Handle client disconnection
  ws.on('close', (code, reason) => {
    log.info('Client disconnected.', 'Code:', code, 'Reason:', reason?.toString() || 'none');
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      // Remove the disconnected client from the room
      room.delete(ws);
      const remainingUsers = room.size;
      log.info(`Client removed from room: ${currentRoomId} (${remainingUsers} users remaining)`);

      // Notify remaining user that the other user left (if any users remain)
      if (remainingUsers > 0) {
        room.forEach(client => {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({
              type: 'user_left',
              roomId: currentRoomId,
              message: 'The other user has left the chat. Waiting for a new user...',
              canSendMessages: false
            }));
          }
        });
        log.info(`Notified remaining user in room ${currentRoomId} that the other user left.`);
      }

      // If the room is now empty, delete it to clean up memory
      if (remainingUsers === 0) {
        rooms.delete(currentRoomId);
        log.info(`Room is now empty and has been deleted: ${currentRoomId}`);
      }
    }
  });

  // Handle potential errors
  ws.on('error', (error) => {
    log.error('WebSocket error:', error);
  });
});
