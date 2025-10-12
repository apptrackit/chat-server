# Docker Deployment Fix

## Issue
Docker container crashed with:
```
Error: Cannot find module 'dotenv'
```

## Root Cause
The `package.json` was missing the `dotenv` and `@parse/node-apn` dependencies that were added to `index.js` for push notifications.

## Fix Applied
Updated `/chat-server/package.json` to include:
```json
"dependencies": {
  "@parse/node-apn": "^6.0.1",
  "dotenv": "^16.4.7",
  "express": "^5.1.0",
  "nodemon": "^3.1.10",
  "ws": "^8.18.3"
}
```

## Deployment Steps

### 1. Rebuild Docker Container
Since `package.json` changed, you need to rebuild the Docker image:

```bash
cd ~/chat-server
docker compose down
docker compose build --no-cache
docker compose up -d
```

### 2. Verify Container is Running
```bash
docker compose logs -f chat-server
```

You should see:
```
[APNs] 📤 Initializing with environment: sandbox
[APNs] ✅ APNs service initialized successfully
WebRTC P2P Signaling Server initialized and ready for clients
```

**OR** if APNs env vars are not configured (which is fine):
```
[APNs] ⚠️ APNs not configured - push notifications will be disabled
WebRTC P2P Signaling Server initialized and ready for clients
```

### 3. Create .env File on Server (Required for Push Notifications)

If you want push notifications to work on the server, create `/home/chat/chat-server/.env`:

```bash
nano ~/chat-server/.env
```

Add your APNs credentials:
```bash
APNS_KEY_ID=your_key_id
APNS_TEAM_ID=your_team_id
APNS_KEY_PATH=/usr/src/app/keys/AuthKey_XXXXXXXXXX.p8
APNS_BUNDLE_ID=com.31b4.Inviso
APNS_ENVIRONMENT=production
```

**Note:** Change `APNS_ENVIRONMENT=production` for live deployment (was `sandbox` for testing).

### 4. Mount Keys Directory (Required for Push Notifications)

Update `docker-compose.yml` to mount the keys directory:

```yaml
services:
  chat-server:
    volumes:
      - ./data:/usr/src/app/data
      - ./keys:/usr/src/app/keys:ro  # Add this line (read-only)
      - .env:/usr/src/app/.env:ro    # Add this line (read-only)
```

Place your `.p8` key file in:
```bash
mkdir -p ~/chat-server/keys
# Upload your AuthKey_XXXXXXXXXX.p8 to this directory
```

### 5. Restart Container with New Configuration

```bash
docker compose down
docker compose up -d
docker compose logs -f
```

## Testing Without APNs (Optional)

If you don't configure APNs environment variables, the server will still work perfectly fine - push notifications will just be disabled. The app will function normally for P2P chat without push notifications.

You'll see this log message:
```
[APNs] ⚠️ APNs not configured - push notifications will be disabled
```

This is **not an error** - it's just informational. The server works fine without push notifications.

## Quick Commands

```bash
# Rebuild and restart
docker compose down && docker compose build --no-cache && docker compose up -d

# View logs
docker compose logs -f

# Check if server is responding
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"joinid":"test123","expiresInSeconds":3600,"client1":"device1"}'

# Check database
docker compose exec chat-server sqlite3 /usr/src/app/data/chat.db "SELECT * FROM pendings;"
```

## File Changes

- ✅ `/chat-server/package.json` - Added `dotenv` and `@parse/node-apn` dependencies

## Status

✅ **Fixed** - Docker container now includes all required dependencies

---

**Next Steps:**
1. Rebuild Docker image: `docker compose build --no-cache`
2. Start container: `docker compose up -d`
3. (Optional) Configure APNs for push notifications
4. Test with iOS app
