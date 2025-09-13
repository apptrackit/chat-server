#!/bin/bash
# Local development script

echo "🚀 Starting Chat Server and TURN Server..."

# Start chat server in background
echo "📡 Starting chat server on port 8080..."
cd /Users/benceszilagyi/dev/trackit/chat-server
node index.js &
CHAT_PID=$!

# Wait a moment
sleep 2

# Check if coturn is installed
if command -v turnserver >/dev/null 2>&1; then
    echo "🔄 Starting TURN server on port 3478..."
    turnserver -c turn-server/turnserver.conf &
    TURN_PID=$!
    
    echo "✅ Services started!"
    echo "📡 Chat Server: http://localhost:8080"
    echo "🔄 TURN Server: localhost:3478"
    echo ""
    echo "Press Ctrl+C to stop all services"
    
    # Wait for interrupt
    trap "echo 'Stopping services...'; kill $CHAT_PID $TURN_PID 2>/dev/null; exit" INT
    wait
else
    echo "❌ TURN server (coturn) not installed"
    echo "Install with: brew install coturn"
    echo "Or use Docker: docker compose up -d"
    kill $CHAT_PID 2>/dev/null
fi
