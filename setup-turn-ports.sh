#!/bin/bash
# Server setup script for TURN server ports

# Open firewall ports for TURN server
echo "Opening TURN server ports..."

# TURN server ports
sudo ufw allow 3478/udp comment "TURN server UDP"
sudo ufw allow 3478/tcp comment "TURN server TCP"
sudo ufw allow 5349/udp comment "TURN server TLS UDP" 
sudo ufw allow 5349/tcp comment "TURN server TLS TCP"

# TURN relay port range (required for media relay)
sudo ufw allow 49152:65535/udp comment "TURN relay ports"

# Check if ports are open
echo "Checking if ports are accessible..."
sudo ufw status | grep -E "(3478|5349|49152:65535)"

echo "TURN server ports configured!"
echo ""
echo "Now start your Docker services:"
echo "docker compose up -d"
echo ""
echo "Test TURN server with:"
echo "telnet chat.ballabotond.com 3478"
