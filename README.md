# WebRTC Signaling + TURN Backend

This backend offers WebRTC signaling via WebSockets and a small REST API backed by SQLite to coordinate pairing using short join codes. Media flows peer-to-peer; the server just forwards signaling messages. A separate TURN server can relay media if direct connectivity fails.

Quick links
- New DB schema (pendings + rooms)
- New REST API: create, accept, check, get, delete
- WebSocket message types
- Local dev and Docker
- TURN and reverse proxy notes

---

## New Database Architecture

We split pairing into two stages:
- pendings: created by client1 with a short join code (joinid), an expiration timestamp (exp, ISO-8601 UTC), and client1 id. client2 is empty until accepted.
- rooms: created when client2 accepts. Contains the final roomid and both client ids.

Schema (`scripts/init-db.sql`)
- pendings: joinid (PK, TEXT NOT NULL), client1 (TEXT NOT NULL), exp (DATETIME NOT NULL, UTC ISO-8601), client2 (TEXT NULL)
- rooms: roomid (PK, TEXT NOT NULL), client1 (TEXT NOT NULL), client2 (TEXT NOT NULL)

Indices
- pendings: by client1, by exp
- rooms: by client1, by client2

Expiration
- A periodic task deletes expired records from pendings (exp <= CURRENT_TIMESTAMP).

---

## REST API (HTTP)

Base URL: http://host:PORT
Content-Type: application/json

1) Create pending (client1)
- POST /api/rooms
- Body: { joinid: string, exp: string(ISO-8601 UTC), client1: string }
- Success: 201 { ok: true }
- Errors: 400 { error: "missing_field" }, 500

2) Accept with code (client2 → room created)
- POST /api/rooms/accept
- Body: { joinid: string, client2: string }
- Success: 200 { roomid: string }
- Errors: 400 (missing fields), 404 { error: "not_found_or_expired" }, 409 { error: "conflict" }, 500

3) Check if accepted (client1 polling)
- POST /api/rooms/check
- Body: { joinid: string, client1: string }
- Success: 200 { roomid: string } and the pending row is deleted server-side
- Pending: 204 No Content
- Errors: 400 (missing), 404 { error: "not_found_or_expired" }, 500

4) Get room by id
- GET /api/rooms?roomid=...
- Success: 200 { roomid, client1, client2 }
- Errors: 400 (missing roomid), 404, 500

5) Delete room (idempotent)
- DELETE /api/rooms
- Body: { roomid: string }
- Success: 200
- Errors: 400 (missing roomid), 500

6) Purge all data for a device
- POST /api/user/purge
- Body: { deviceId: string }
- Success: 200 { ok: true, roomsDeleted: number, pendingsDeleted: number }
- Errors: 400 (missing deviceId), 500

Notes
- Use proper UTC timestamps like "2030-01-01T00:00:00Z" for exp.
- All errors use appropriate HTTP status codes as above.
- API is enabled when USE_SQLITE=1.

Example sequence
1. client1 → POST /api/rooms { joinid, exp, client1 } → 201
2. client2 → POST /api/rooms/accept { joinid, client2 } → 200 { roomid }
3. client1 polls → POST /api/rooms/check { joinid, client1 } → 200 { roomid } once accepted (204 before that)

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

