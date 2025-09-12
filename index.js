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
  res.send('WebRTC Signaling Server is active.');
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
        currentRoomId = roomId; // Store the room ID for this connection

        // If the room doesn't exist, create it
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
          log.info(`Created new room: ${roomId}`);
        }

        // Add the client to the specified room
        rooms.get(roomId).add(ws);
        log.info(`Client joined room: ${roomId}`);
        ws.send(JSON.stringify({ type: 'joined_room', roomId }));
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
        if (room) {
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
        } else {
          log.warn(`Tried to relay '${parsedMessage.type}' but room not found:`, currentRoomId);
        }
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
      log.info(`Client removed from room: ${currentRoomId}`);

      // If the room is now empty, delete it to clean up memory
      if (room.size === 0) {
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
