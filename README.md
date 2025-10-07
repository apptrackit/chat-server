# WebRTC Signaling + TURN Backend

This backend offers WebRTC signaling via WebSockets and a small REST API backed by SQLite to coordinate pairing using short join codes. Media flows peer-to-peer; the server just forwards s## Security Recommendations

- Use WSS (TLS) for signaling in production.
- TURN with long-term credentials; avoid anonymous no-auth in production.
- Limit TURN to required ports and IPs; monitor logs for abuse.
- Consider rate limiting join attempts and message sizes on signaling.
- Don't trust client SDP contents; validate JSON shapes where possible.
- **Ephemeral Device IDs**: Clients should use unique ephemeral IDs per session for privacy; the purge API supports batch deletion of multiple IDs.
- **Automatic Cleanup**: Implement automatic expiration of old rooms and pendings to prevent database bloat.

---messages. A separate TURN server can relay media if direct connectivity fails.

Quick links
- New DB schema (pendings + rooms)
- New REST API: create, accept, check, get, delete
- WebSocket message types
- Local dev and Docker
- TURN and reverse proxy notes

---

## New Database Architecture

We split pairing into two stages:
- **pendings**: created by client1 with a short join code (joinid), an expiration in seconds (expiresInSeconds), and client1 id. client2 is empty until accepted.
- **rooms**: created when client2 accepts. Contains the final roomid and both client ids.

Schema (`scripts/init-db.sql`)
- **pendings**: joinid (PK, TEXT NOT NULL), client1 (TEXT NOT NULL), exp (DATETIME NOT NULL, UTC ISO-8601), client2 (TEXT NULL)
- **rooms**: roomid (PK, TEXT NOT NULL), client1 (TEXT NOT NULL), client2 (TEXT NOT NULL)

Indices
- pendings: by client1, by exp
- rooms: by client1, by client2

Expiration & Cleanup
- **Server-side calculation**: Clients send `expiresInSeconds` (duration), server calculates exact `exp` timestamp
- **Automatic cleanup**: SQL triggers delete expired pendings on INSERT/UPDATE
- **Atomic operations**: Cleanup happens in same transaction as queries (no race conditions)
- **Proper datetime comparison**: Uses `datetime()` function for accurate timestamp comparison

---

## REST API (HTTP)

Base URL: http://host:PORT
Content-Type: application/json

### 1) Create pending (client1)
- **POST** `/api/rooms`
- **Body**: `{ joinid: string, expiresInSeconds: number, client1: string }`
  - `joinid`: 6-digit join code
  - `expiresInSeconds`: Duration in seconds (1-86400, max 24 hours)
  - `client1`: Device UUID (use ephemeral IDs for privacy)
- **Success**: `201 { ok: true, exp: "2025-10-07T10:00:00.000Z" }`
  - Server calculates and returns the exact expiry timestamp
- **Errors**: 
  - `400 { error: "missing_field" }` - Missing required parameter
  - `400 { error: "invalid_expiresInSeconds", details: "must be 1-86400 seconds (1 sec to 24 hours)" }`
  - `500` - Server error

**Common duration values:**
- 1 minute = `60`
- 5 minutes = `300`
- 10 minutes = `600`
- 1 hour = `3600`
- 12 hours = `43200`
- 24 hours = `86400`

### 2) Accept with code (client2 → room created)
- **POST** `/api/rooms/accept`
- **Body**: `{ joinid: string, client2: string }`
- **Success**: `200 { roomid: string }`
- **Errors**: 
  - `400` - Missing fields
  - `404 { error: "not_found_or_expired" }` - Code doesn't exist or expired
  - `409 { error: "conflict" }` - Code already accepted
  - `500` - Server error

### 3) Check if accepted (client1 polling)
- **POST** `/api/rooms/check`
- **Body**: `{ joinid: string, client1: string }`
- **Success**: `200 { roomid: string }` - Room created, pending deleted server-side
- **Pending**: `204 No Content` - Still waiting for client2
- **Errors**: 
  - `400` - Missing fields
  - `404 { error: "not_found_or_expired" }` - Code doesn't exist or expired
  - `500` - Server error

### 4) Get room by id
- **GET** `/api/rooms?roomid=...`
- **Success**: `200 { roomid, client1, client2 }`
- **Errors**: `400` (missing roomid), `404`, `500`

### 5) Delete room (idempotent)
- **DELETE** `/api/rooms`
- **Body**: `{ roomid: string }`
- **Success**: `200`
- **Errors**: `400` (missing roomid), `500`

### 6) Purge all data for device(s)
- **POST** `/api/user/purge`
- **Body**: `{ deviceIds: string[] }` OR `{ deviceId: string }` (legacy)
- **Success**: `200 { success: true, deviceIdCount: number, roomsDeleted: number, pendingsDeleted: number }`
- **Errors**: 
  - `400` - Missing deviceIds/deviceId, empty array, or invalid IDs
  - `500` - Server error
- **Notes**:
  - Preferred format uses `deviceIds` array for batch deletion
  - Legacy single `deviceId` string format still supported
  - Deletes all rooms and pendings where client1 or client2 matches any provided device ID

---

### Example Sequence

**Creating and joining a room:**
1. **Client1** → `POST /api/rooms { joinid: "123456", expiresInSeconds: 300, client1: "device-uuid-1" }` → `201 { ok: true, exp: "2025-10-07T10:05:00.000Z" }`
2. **Client2** → `POST /api/rooms/accept { joinid: "123456", client2: "device-uuid-2" }` → `200 { roomid: "abc123..." }`
3. **Client1** polls → `POST /api/rooms/check { joinid: "123456", client1: "device-uuid-1" }` → `200 { roomid: "abc123..." }`
4. Both clients connect via WebSocket using `roomid`

**Batch purge:**
1. Client has ephemeral IDs: `["id1", "id2", "id3"]`
2. Client → `POST /api/user/purge { deviceIds: ["id1", "id2", "id3"] }` → `200 { success: true, deviceIdCount: 3, roomsDeleted: 5, pendingsDeleted: 2 }`

---

## WebSocket Signaling

Inbound from client → server
- join_room: { type: "join_room", roomId: string }
- leave_room: { type: "leave_room" }
- webrtc_offer: { type: "webrtc_offer", sdp: string }
- webrtc_answer: { type: "webrtc_answer", sdp: string }
- ice_candidate: { type: "ice_candidate", candidate: { candidate, sdpMLineIndex, sdpMid } }
- ping: { type: "ping" }

Outbound from server → client
- connected, room_joined, room_ready, webrtc_offer, webrtc_answer, ice_candidate, peer_left, peer_disconnected, left_room, room_full, error

Notes
- WebSocket roomId should be the roomid returned by the REST accept/check phase.

---

## Local Development

Prereqs
- Node.js 18+ (tested on 22.x)
- sqlite3 CLI available on PATH

Install and init DB
```bash
npm install
npm run db:init
```

Run server
```bash
USE_SQLITE=1 npm run dev
```

Environment
```bash
PORT=8080
# optional; defaults to ./data/chat.db
SQLITE_DB_PATH=./data/chat.db
```

---

## Docker / Reverse Proxy / TURN

- Docker Compose included to run signaling and coturn.
- Put a TLS reverse proxy (nginx, Caddy) in front for WSS.
- Ensure TURN (coturn) ports are open if you need relay: 3478 UDP/TCP, 5349 TCP, plus UDP relay range.

---

## Troubleshooting

- GET / returns a simple health message.
- GET /rooms shows in-memory WS rooms (for debugging only).
- If REST calls return 404 on /check, the join code likely expired or was never created.
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

This project uses the `sqlite3` CLI (no native Node addons) to initialize and access a simple `rooms` table.

Defaults
- DB file: `./data/chat.db` (override with `SQLITE_DB_PATH=/custom/path.db`)
- Schema file: `./scripts/init-db.sql`

Initialize the DB
```bash
npm install
npm run db:init
```

Enable API and DB hooks
```bash
USE_SQLITE=1 npm run dev
```

Environment
```bash
# optional; defaults to ./data/chat.db
export SQLITE_DB_PATH=$PWD/data/chat.db
```

Notes
- Docker Compose installs `sqlite` in the container and runs `npm run db:init` automatically.
- If `USE_SQLITE` is not set, the Rooms API is disabled.

