# WebRTC Signaling + TURN Backend (Deep Guide)

This backend provides a minimal, production-friendly WebRTC signaling service with optional TURN relay, suitable for mobile and web peers. It handles room join/leave, WebRTC offer/answer exchange, and ICE candidate forwarding. A separate TURN server enables P2P across restrictive NATs and different networks.

Contents
- Architecture overview
- Components and responsibilities
- Message types and schemas
- Room lifecycle and step-by-step flows
- Deployment (Docker Compose, environment)
- Reverse proxy for WSS
- TURN: purpose, config, and ports
- Security recommendations
- Troubleshooting and verification

---

## Architecture Overview

Two cooperating services:
- Signaling server (Node.js + WebSocket): Establishes rendezvous between two peers in a room and forwards signaling messages (SDP and ICE). No media flows through it.
- TURN server (coturn): Relays media/data when direct P2P paths fail due to NAT/firewall. Only used if needed by ICE negotiation.

High level flow:
1) Each client opens a secure WebSocket (WSS) to signaling and joins a room (by string ID).
2) When two clients are present, signaling marks the room ready and designates one as initiator.
3) Initiator creates SDP offer → signaling forwards to receiver → receiver replies with SDP answer.
4) Both sides exchange ICE candidates via signaling until a viable path is found (host, srflx, or relay).
5) Data/media flows directly peer-to-peer; signaling is only used for control messages.

---

## Components and Responsibilities

Signaling server (`index.js`)
- WebSocket handling: connection, message parsing, safe forwarding.
- Room registry: Map of `roomId -> Set<clientId>`.
- Client registry: Map of `clientId -> { ws, roomId, isInitiator }`.
- Business rules: max two peers per room; initiator assignment; cleanup on leave/disconnect; informative logs.

TURN server (`turn-server/turnserver.conf`)
- Provides STUN/TURN services. With credentials, clients can allocate relay candidates.
- Required ports must be accessible; see TURN section below.

Docker Compose (`docker-compose.yml`)
- Runs both services locally or on a host. Mounts the signaling code; starts coturn with provided config.

Public folder (`public/`)
- Static assets if needed (not required for mobile clients).

---

## Message Types and Schemas

Inbound from client → signaling:
- join_room: `{ type: "join_room", roomId: string }`
- leave_room: `{ type: "leave_room" }`
- webrtc_offer: `{ type: "webrtc_offer", sdp: string }`
- webrtc_answer: `{ type: "webrtc_answer", sdp: string }`
- ice_candidate: `{ type: "ice_candidate", candidate: { candidate: string, sdpMLineIndex: number, sdpMid: string } }`
- ping: `{ type: "ping" }`

Outbound from signaling → client:
- connected: `{ type: "connected", clientId: string, server: string }`
- room_joined: `{ type: "room_joined", roomId: string, userCount: 1|2, isInitiator: boolean, ready: boolean }`
- room_ready: `{ type: "room_ready", roomId: string, userCount: 2, isInitiator: boolean }`
- webrtc_offer / webrtc_answer / ice_candidate: forwarded as above plus `{ from: clientId, roomId }`
- peer_left: `{ type: "peer_left", message: string }`
- peer_disconnected: `{ type: "peer_disconnected", message: string }`
- left_room: `{ type: "left_room", roomId: string|null }`
- room_full: `{ type: "room_full", error: string, roomId: string }`
- error: `{ type: "error", error: string }`

Notes:
- Signaling does not inspect SDP contents; it carries opaque strings.
- ICE candidate messages must include the raw candidate line and indexes.

---

## Room Lifecycle and Step-by-Step Flows

Room join:
1) Client A → `join_room(roomId)` → server creates room and marks A as initiator; returns `room_joined` (1/2).
2) Client B → `join_room(roomId)` → server adds B as receiver; returns `room_joined` (2/2) to B.
3) Server → both: `room_ready` with `isInitiator` true for the first client (A), false for the second (B).

Offer/answer exchange:
4) Initiator (A) creates SDP offer and sends `webrtc_offer` → server forwards to B.
5) Receiver (B) sets remote offer, creates SDP answer, sends `webrtc_answer` → server forwards to A.

ICE exchange:
6) Both peers gather ICE candidates and send `ice_candidate` messages → server forwards to the other peer.
7) When a viable path is found (HOST/SRFLX/RELAY), ICE state becomes Connected/Completed and the data/media channel opens.

Leaving / disconnects:
8) A client may send `leave_room` → server removes it from the room, notifies peer with `peer_left`, deletes empty rooms, and confirms with `left_room`.
9) If a connection drops unexpectedly, server calls that `peer_disconnected`; remaining peer gets notified, and room is deleted if empty.

Health and cleanup:
10) `/` (HTTP) returns a health page and logs the request.
11) A periodic sweep removes stale client entries if sockets are no longer open.

---

## Deployment (Docker Compose)

Prerequisites
- Docker and Docker Compose installed.
- Optional: `.env` file at repo root with the server port, e.g. `PORT=8080`.

Start services
```bash
docker compose up --build
```

Run in background
```bash
docker compose up -d --build
```

Stop and remove
```bash
docker compose down
```

The signaling service listens on `http://localhost:${PORT}` and upgrades to WebSocket for `/`.

---

## Reverse Proxy (WSS)

For production with TLS termination (e.g., nginx):
- Ensure HTTP/1.1 upgrade headers are forwarded:
	- `proxy_http_version 1.1`
	- `proxy_set_header Upgrade $http_upgrade;`
	- `proxy_set_header Connection "upgrade";`
- Extend timeouts to avoid idle disconnects:
	- `proxy_read_timeout 3600; proxy_send_timeout 3600; keepalive_timeout 3600;`
- Point `wss://your-domain` to the signaling service upstream.

---

## TURN: Purpose, Config, and Ports

Why TURN?
- NAT traversal often works with STUN (host/srflx candidates), but in carrier-grade NATs or strict firewalls, only TURN relay succeeds. TURN relays media/data between peers when direct P2P isn’t possible.

Configuration (`turn-server/turnserver.conf`)
- Typical important settings:
	- `lt-cred-mech` with `user=<username>:<password>` for long-term credentials.
	- `realm=<your-domain>`
	- `listening-port=3478` (UDP/TCP)
	- `tls-listening-port=5349` (for TURN over TLS, a.k.a. `turns:`)
	- `external-ip=<public-ip-or-dns>`
	- `min-port=49152` and `max-port=65535` for relay allocations

Ports to open on the host/firewall
- 3478/udp (TURN)
- 3478/tcp (TURN over TCP)
- 5349/tcp (TURN over TLS)
- 49152–65535/udp (relay ports range)

Clients should be configured with a mix of STUN/TURN servers, e.g.:
- `stun:stun.l.google.com:19302`
- `turn:your-domain:3478` (UDP)
- `turn:your-domain:3478?transport=tcp`
- `turns:your-domain:5349` (TLS)
- Optionally, a public TURN (e.g., openrelay.metered.ca) as fallback.

Operational notes
- TURN allocates relayed addresses per session, so bandwidth costs can apply.
- Prefer UDP, but keep TCP/TLS variants for networks blocking UDP.

---

## Security Recommendations

- Use WSS (TLS) for signaling in production.
- TURN with long-term credentials; avoid anonymous no-auth in production.
- Limit TURN to required ports and IPs; monitor logs for abuse.
- Consider rate limiting join attempts and message sizes on signaling.
- Don’t trust client SDP contents; validate JSON shapes where possible.

---

## Troubleshooting and Verification

Basics
- Health check: `GET /` should log "Health check" and return a short page.
- Room introspection: `GET /rooms` returns list of rooms with counts.

Common symptoms
- Unknown message type:
	- Ensure clients send `type` values as described; keep server up to date.
- Can’t rejoin same room after leave:
	- Verify server has `leave_room` handler (present in `index.js`).
	- Check `/rooms` to ensure old room cleaned up. If not, the connection may not have closed—ensure the client sends `leave_room` or the socket closes.
- P2P works only on WiFi but not across networks:
	- Confirm TURN ports open and reachable; check you see `typ relay` candidates in client logs.
	- Add TCP/TLS TURN URIs for networks that block UDP.
- WebSocket drops after idle:
	- Ensure proxy timeouts are generous and clients send pings.

Verifying TURN
- From clients, log ICE candidates and look for `typ relay`.
- In coturn logs, you should see allocations when a session relays.

---

## Local Development Notes

Node version: 22.19.0

Environment
```
PORT=8080
```

Run signaling only (without Docker)
```bash
npm install
npm run db:init
npm run dev
```

Run both via Docker Compose
```bash
docker compose up --build
```

Access
- Signaling: http://localhost:8080 (upgrades to WS)
- TURN: provided by coturn container (host networking if configured)

---

## SQLite Setup

This project can optionally persist lightweight room/client/message metadata in a local SQLite database using `better-sqlite3`.

Defaults
- DB file: `./data/chat.db` (override with `SQLITE_DB_PATH=/custom/path.db`)
- Schema file: `./scripts/init-db.sql`

Initialize the DB
```bash
npm install
npm run db:init
```

Environment
```bash
# optional; defaults to ./data/chat.db
export SQLITE_DB_PATH=$PWD/data/chat.db
```

Notes
- Server starts even if the DB is not available; DB calls are best-effort.
- WAL mode is enabled for safe concurrent reads.

