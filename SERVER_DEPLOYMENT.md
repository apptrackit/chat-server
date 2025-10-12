# Server Deployment Instructions

## 🚀 Deploy to Production Server

Your chat server is running at: **chat.ballabotond.com**

### Current Status
✅ Docker container running  
⚠️ Missing `dotenv` and `@parse/node-apn` packages (needs rebuild)

---

## Step 1: Update Package Dependencies

SSH into your server:
```bash
ssh chat@chat.ballabotond.com
cd ~/chat-server
```

The `package.json` has been updated locally. You need to pull the changes:

```bash
# Pull latest changes from git
git pull origin ping

# OR manually update package.json to include:
# "dotenv": "^16.4.7"
# "@parse/node-apn": "^6.0.1"
```

---

## Step 2: Rebuild Docker Container

Since package.json changed, rebuild the Docker image:

```bash
cd ~/chat-server
docker compose down
docker compose build --no-cache
docker compose up -d
```

**Expected output:**
```
[+] Building 45.2s (12/12) FINISHED
[+] Running 2/2
 ✔ Container turn-server   Started
 ✔ Container chat-server   Started
```

---

## Step 3: Verify Server is Running

Check the logs:
```bash
docker compose logs -f chat-server
```

You should see one of these:

### Option A: APNs Configured (Push Notifications Enabled)
```
[APNs] 📤 Initializing with environment: production
[APNs] ✅ APNs service initialized successfully
WebRTC P2P Signaling Server initialized and ready for clients
```

### Option B: APNs Not Configured (Push Notifications Disabled)
```
[APNs] ⚠️ APNs not configured - push notifications will be disabled
WebRTC P2P Signaling Server initialized and ready for clients
```

**Both are valid!** Option B means the server works perfectly, just without push notifications.

---

## Step 4: Configure APNs (Optional - For Push Notifications)

If you want push notifications to work, you need to configure APNs on the server.

### 4a. Create .env File

```bash
cd ~/chat-server
nano .env
```

Add these lines (replace with your actual values):
```bash
APNS_KEY_ID=AB12CD34EF
APNS_TEAM_ID=XYZ9876543
APNS_KEY_PATH=/usr/src/app/keys/AuthKey_XXXXXXXXXX.p8
APNS_BUNDLE_ID=com.31b4.Inviso
APNS_ENVIRONMENT=production
```

**Important:** Use `production` not `sandbox` for live deployment!

### 4b. Upload APNs Key File

Create keys directory:
```bash
mkdir -p ~/chat-server/keys
```

Upload your `.p8` key file to the server:
```bash
# On your local machine:
scp /path/to/AuthKey_XXXXXXXXXX.p8 chat@chat.ballabotond.com:~/chat-server/keys/
```

### 4c. Update docker-compose.yml

Edit `docker-compose.yml` to mount the .env and keys:
```bash
nano ~/chat-server/docker-compose.yml
```

Add these volume mounts under the `chat-server` service:
```yaml
services:
  chat-server:
    volumes:
      - ./data:/usr/src/app/data
      - ./keys:/usr/src/app/keys:ro      # Add this line
      - ./.env:/usr/src/app/.env:ro      # Add this line
```

### 4d. Restart Container

```bash
docker compose down
docker compose up -d
docker compose logs -f
```

Now you should see:
```
[APNs] ✅ APNs service initialized successfully
```

---

## Step 5: Test the Server

### Test 1: Basic Health Check
```bash
curl https://chat.ballabotond.com/api/rooms/check \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"joinid":"test123","client1":"device1"}'
```

Expected response: `204 No Content` (pending doesn't exist)

### Test 2: Create a Room
```bash
curl https://chat.ballabotond.com/api/rooms \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"joinid":"test456","expiresInSeconds":3600,"client1":"device1"}'
```

Expected response: `200 OK`

### Test 3: WebSocket Connection
```bash
# Install wscat if not already installed
npm install -g wscat

# Connect to WebSocket
wscat -c wss://chat.ballabotond.com
```

Expected: Connection established, server sends `{"type":"connected","clientId":"..."}`

---

## Database Management

### View Database Contents
```bash
docker compose exec chat-server sqlite3 /usr/src/app/data/chat.db
```

Inside sqlite:
```sql
-- View schema
.schema

-- View pending sessions
SELECT * FROM pendings;

-- View active rooms
SELECT roomid, client1, client2, client1_token FROM rooms;

-- Exit
.quit
```

### Recreate Database (If Needed)
```bash
docker compose exec chat-server rm /usr/src/app/data/chat.db
docker compose restart chat-server
```

The database will be recreated automatically with the new schema.

---

## Monitoring

### View Live Logs
```bash
docker compose logs -f
```

### View Last 100 Lines
```bash
docker compose logs --tail=100
```

### Check Container Status
```bash
docker compose ps
```

### Check Resource Usage
```bash
docker stats
```

---

## Troubleshooting

### Server Crashes on Startup
Check logs:
```bash
docker compose logs chat-server
```

Common issues:
- ❌ Missing `dotenv` package → Rebuild container after updating package.json
- ❌ Invalid APNs key path → Check `APNS_KEY_PATH` in .env
- ❌ Database locked → Stop container, remove data/chat.db, restart

### Push Notifications Not Working
1. Check server logs for APNs initialization:
   ```bash
   docker compose logs -f | grep APNs
   ```

2. Verify .env file exists and is mounted:
   ```bash
   docker compose exec chat-server cat /usr/src/app/.env
   ```

3. Verify .p8 key file exists:
   ```bash
   docker compose exec chat-server ls -la /usr/src/app/keys/
   ```

4. Check iOS device token is being sent:
   - Look for logs showing token registration in iOS Xcode console
   - Check database: `SELECT client1_token FROM rooms;`

### WebSocket Connection Fails
1. Check nginx configuration (if using nginx as reverse proxy)
2. Verify WebSocket upgrade headers are being forwarded
3. Check firewall rules allow WebSocket connections

---

## Security Checklist

- [ ] `.env` file has correct permissions (chmod 600)
- [ ] `.p8` key file has correct permissions (chmod 600)
- [ ] APNs environment set to `production` (not `sandbox`)
- [ ] Database directory is mounted as volume (data persists across restarts)
- [ ] Docker network isolated from public (only port 8080 exposed)
- [ ] SSL/TLS enabled via nginx reverse proxy

---

## Quick Commands Reference

```bash
# Rebuild everything
docker compose down && docker compose build --no-cache && docker compose up -d

# View logs
docker compose logs -f

# Restart server
docker compose restart chat-server

# Stop everything
docker compose down

# Remove all data (⚠️ DESTRUCTIVE)
docker compose down -v
```

---

## File Locations on Server

```
~/chat-server/
├── .env                    # APNs configuration (create this)
├── docker-compose.yml      # Docker configuration
├── package.json            # Node dependencies (update this)
├── index.js                # Main server file
├── data/
│   └── chat.db            # SQLite database (auto-created)
├── keys/                   # APNs key directory (create this)
│   └── AuthKey_*.p8       # Your APNs key file (upload this)
└── src/
    ├── apns-service.js    # APNs service (pull from git)
    └── db-cli.js          # Database functions (pull from git)
```

---

## Next Steps

1. ✅ Rebuild Docker container with updated package.json
2. ⬜ (Optional) Configure APNs for push notifications
3. ⬜ Test with iOS app on physical devices
4. ⬜ Monitor logs for any errors
5. ⬜ Set up automated backups for database

---

**Server:** chat.ballabotond.com  
**Branch:** ping  
**Status:** Ready to deploy with push notification support
