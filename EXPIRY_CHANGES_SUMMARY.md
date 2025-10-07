# Expiry System - Summary of Changes

## 🎯 Final Solution: Server-Side Expiry Calculation

### What Changed

#### Before (Broken)
```json
// Client sends expiry date
{
  "joinid": "123456",
  "client1": "device-uuid",
  "exp": "2025-10-07T10:00:00Z"  // ❌ Client-calculated
}
```

**Problems:**
- ❌ Clock skew between devices
- ❌ Timezone issues
- ❌ String comparison instead of datetime
- ❌ Race conditions in queries

#### After (Fixed)
```json
// Client sends duration in seconds
{
  "joinid": "123456",
  "client1": "device-uuid",
  "expiresInSeconds": 300  // ✅ Server calculates
}
```

**Benefits:**
- ✅ Server clock is source of truth
- ✅ No clock skew
- ✅ Proper datetime comparison
- ✅ Atomic transactions

## 📝 Changes Made

### 1. API Endpoint (`index.js`)
- **Removed:** `exp` parameter (client-provided date)
- **Added:** `expiresInSeconds` parameter (duration)
- **Server now calculates:** `exp = new Date(Date.now() + seconds * 1000).toISOString()`
- **Validation:** 1-86400 seconds (1 sec to 24 hours)

### 2. Database Queries (`db-cli.js`)
- **Fixed:** All datetime comparisons now use `datetime()` function
- **Changed:** `exp <= CURRENT_TIMESTAMP` → `datetime(exp) <= datetime('now')`
- **Fixed:** DELETE + SELECT now in ONE atomic transaction (no race conditions)

### 3. SQL Triggers (`init-db.sql`)
- **Updated:** All triggers use `datetime()` for proper comparison
- **Cleanup:** Expired pendings deleted on INSERT and UPDATE

## 🧪 Tests Created

1. **`test-expiry.js`** - Basic expiry cleanup (DB level)
2. **`test-accept-expired.js`** - Verify expired pendings rejected (DB level)
3. **`test-server-expiry.js`** - Server-calculated expiry (DB level)
4. **`test-api-expiry.js`** - Full API integration test (HTTP level)

All tests pass ✅

## 🔄 iOS App Changes Required

### Update your API client:

**Old Code (Remove):**
```swift
let expiryDate = Date().addingTimeInterval(300)
let exp = ISO8601DateFormatter().string(from: expiryDate)
```

**New Code:**
```swift
struct CreateRoomRequest: Codable {
    let joinid: String
    let client1: String
    let expiresInSeconds: Int  // New field
}

// Example: 5-minute expiry
let request = CreateRoomRequest(
    joinid: generateJoinCode(),
    client1: deviceId,
    expiresInSeconds: 300  // Just send seconds!
)
```

### Common Duration Values

```swift
enum RoomDuration {
    case oneMinute = 60
    case fiveMinutes = 300
    case tenMinutes = 600
    case thirtyMinutes = 1800
    case oneHour = 3600
}
```

## ✅ Verification Steps

1. **Restart server:**
   ```bash
   cd /Users/benceszilagyi/dev/trackit/chat-server
   USE_SQLITE=1 node index.js
   ```

2. **Run tests (optional):**
   ```bash
   node test-api-expiry.js  # Full API test
   ```

3. **Update iOS app** to use `expiresInSeconds`

4. **Test with app:**
   - Create room with 1-minute expiry
   - Join immediately (should work)
   - Wait 61 seconds
   - Try to join (should fail with 404)

## 🔐 Security & Accuracy

- ✅ Server is source of truth for time
- ✅ No tampering with expiry dates
- ✅ Automatic cleanup of expired sessions
- ✅ Atomic operations prevent race conditions
- ✅ Proper datetime comparison (not string comparison)

## 📚 Documentation

- `API_EXPIRY_UPDATE.md` - API documentation for iOS developers
- All test files include inline documentation
- Schema comments updated in `init-db.sql`
