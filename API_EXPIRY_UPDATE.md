# API Update: Server-Side Expiry Calculation

## Overview
The server now calculates expiry dates to eliminate clock skew issues between devices.

**Key Change:** Clients send duration in seconds (`expiresInSeconds`), server calculates the exact expiry timestamp.

## Creating a Pending Room

### Endpoint
`POST /api/rooms`

### Request Body
```json
{
  "joinid": "123456",
  "client1": "DEVICE-UUID-HERE",
  "expiresInSeconds": 300
}
```

### Parameters
- **`joinid`** (required, string): The join code for the room
- **`client1`** (required, string): Device UUID of the creator
- **`expiresInSeconds`** (required, integer): Duration until expiry
  - Minimum: `1` second
  - Maximum: `86400` seconds (24 hours)
  - Common values:
    - 1 minute = `60`
    - 5 minutes = `300`
    - 10 minutes = `600`
    - 30 minutes = `1800`
    - 1 hour = `3600`

### Response
```json
{
  "ok": true,
  "exp": "2025-10-07T09:47:43.560Z"
}
```

The `exp` field contains the server-calculated expiry timestamp (UTC).

## Benefits
✅ **Accurate expiry** - Server clock is the source of truth
✅ **No clock skew** - Eliminates issues from device time differences
✅ **No timezone issues** - Server uses UTC for all calculations
✅ **Simple client code** - Just send seconds, server handles the rest

## iOS/Swift Example

```swift
struct CreateRoomRequest: Codable {
    let joinid: String
    let client1: String
    let expiresInSeconds: Int
}

// Create a pending with 5-minute expiry
let request = CreateRoomRequest(
    joinid: generateJoinCode(),
    client1: deviceId,
    expiresInSeconds: 300  // 5 minutes
)

// Make API call
let response = try await apiClient.post("/api/rooms", body: request)
// response.exp contains the server-calculated expiry time
```

## Error Responses

### Missing Required Field
```json
{
  "error": "missing_joinid"  // or missing_client1, missing_expiresInSeconds
}
```

### Invalid expiresInSeconds
```json
{
  "error": "invalid_expiresInSeconds",
  "details": "must be 1-86400 seconds (1 sec to 24 hours)"
}
```

## Testing Expiry

After creating a pending:
1. ✅ Try to join immediately (should work)
2. ✅ Wait until after expiry time
3. ✅ Try to join (should get 404 error - "not_found_or_expired")
4. ✅ Check status (should get "not_found")

The server automatically deletes expired pendings before any read/write operation.
