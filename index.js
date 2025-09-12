// server.js

// 1. Import necessary libraries
// 'express' for creating the HTTP server
// 'ws' for WebSocket communication
const express = require('express');
const { Server } = require('ws');

// 2. Server Setup
const PORT = process.env.PORT || 8080;
const app = express();

// Use a basic route for health checks or info
app.get('/', (req, res) => {
  res.send('WebRTC Signaling Server is active.');
});

// Create an HTTP server from the Express app
const server = app.listen(PORT, () => {
  console.log(`✅ Server is listening on port: ${PORT}`);
});

// 3. WebSocket Server Initialization
// Attach the WebSocket server to the HTTP server
const wss = new Server({ server });

// 4. In-memory data structure to store rooms and clients
// A Map is used where:
// key = roomId (string)
// value = a Set of connected WebSocket clients in that room
const rooms = new Map();

// 5. WebSocket Connection Handling
wss.on('connection', (ws, req) => {
  console.log('🔌 New client connected.');

  // This variable will be set when the client joins a room
  let currentRoomId = null;

  // 6. Handle incoming messages from clients
  ws.on('message', (message) => {
    let parsedMessage;
    try {
      // Messages are expected to be in JSON format
      parsedMessage = JSON.parse(message);
    } catch (error) {
      console.error('Failed to parse message:', message, error);
      return;
    }

    // Use a switch statement to handle different message types
    switch (parsedMessage.type) {
      // A. Case for when a client wants to join a room
      case 'join_room': {
        const { roomId } = parsedMessage.payload;
        currentRoomId = roomId; // Store the room ID for this connection

        // If the room doesn't exist, create it
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
          console.log(`🚪 Created new room: ${roomId}`);
        }

        // Add the client to the specified room
        rooms.get(roomId).add(ws);
        console.log(`🙋 Client joined room: ${roomId}`);
        break;
      }

      // B. Cases for WebRTC signaling messages (offer, answer, candidate)
      // These messages are simply broadcasted to other clients in the same room.
      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        const room = rooms.get(currentRoomId);
        if (room) {
          // Broadcast the message to every other client in the room
          room.forEach(client => {
            // Check if the client is not the sender and is ready to receive messages
            if (client !== ws && client.readyState === ws.OPEN) {
              client.send(JSON.stringify(parsedMessage));
            }
          });
          // Log the action for debugging
          console.log(`📢 Relayed '${parsedMessage.type}' in room: ${currentRoomId}`);
        }
        break;
      }

      // C. Default case for unknown message types
      default:
        console.warn('Unknown message type received:', parsedMessage.type);
    }
  });

  // 7. Handle client disconnection
  ws.on('close', () => {
    console.log('🔌 Client disconnected.');
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      // Remove the disconnected client from the room
      room.delete(ws);
      console.log(`👋 Client removed from room: ${currentRoomId}`);

      // If the room is now empty, delete it to clean up memory
      if (room.size === 0) {
        rooms.delete(currentRoomId);
        console.log(`🗑️ Room is now empty and has been deleted: ${currentRoomId}`);
      }
    }
  });

  // Handle potential errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});
