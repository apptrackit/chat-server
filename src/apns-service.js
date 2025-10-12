const apn = require('@parse/node-apn');
const path = require('path');

/**
 * APNs Service for iOS Push Notifications
 * Uses token-based authentication (AuthKey) for secure, scalable push delivery.
 * Designed to work alongside FCM for cross-platform support (iOS + Android).
 */
class APNsService {
  constructor() {
    this.provider = null;
    this.isInitialized = false;
    this.init();
  }

  init() {
    try {
      const keyId = process.env.APNS_KEY_ID;
      const teamId = process.env.APNS_TEAM_ID;
      const keyPath = process.env.APNS_KEY_PATH;
      const bundleId = process.env.APNS_BUNDLE_ID;
      const environment = process.env.APNS_ENVIRONMENT || 'sandbox';

      // Gracefully disable if not configured (Android-only deployment)
      if (!keyId || !teamId || !keyPath || !bundleId) {
        console.warn('[APNs] Missing configuration. iOS push notifications disabled.');
        console.warn('[APNs] Android notifications will still work via FCM.');
        return;
      }

      // Resolve key path relative to project root
      const absoluteKeyPath = path.resolve(keyPath);

      const options = {
        token: {
          key: absoluteKeyPath,
          keyId: keyId,
          teamId: teamId
        },
        production: environment === 'production',
        // Connection settings for reliability
        connectionRetryLimit: 3,
        heartBeat: 60000, // Ping APNs every 60s
        requestTimeout: 5000 // 5s timeout per request
      };

      this.provider = new apn.Provider(options);
      this.bundleId = bundleId;
      this.isInitialized = true;
      
      const env = environment === 'production' ? 'Production' : 'Sandbox';
      console.log(`[APNs] ✅ Initialized successfully (${env})`);
      console.log(`[APNs] Bundle ID: ${bundleId}`);
      console.log(`[APNs] Key ID: ${keyId}`);
    } catch (error) {
      console.error('[APNs] ❌ Initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Send presence notification to iOS device
   * @param {string} deviceToken - APNs device token (64-char hex string)
   * @param {string} roomId - Room ID for deep link
   * @param {string} message - Notification message
   * @returns {Promise<{success: boolean, response?: object, error?: Error}>}
   */
  async sendPresenceNotification(deviceToken, roomId, message = 'Your chat partner is waiting') {
    if (!this.isInitialized || !this.provider) {
      return { 
        success: false, 
        error: new Error('APNs not initialized'),
        skipped: true 
      };
    }

    // Validate token format (64-char hex)
    if (!deviceToken || typeof deviceToken !== 'string' || !/^[0-9a-f]{64}$/i.test(deviceToken)) {
      console.error('[APNs] ❌ Invalid device token format:', deviceToken?.substring(0, 16));
      return { success: false, error: new Error('Invalid device token format') };
    }

    try {
      // Create notification
      const notification = new apn.Notification();
      
      // APNs payload - Standard alert notification
      notification.alert = message;
      notification.sound = 'default';
      notification.badge = 1;
      notification.topic = this.bundleId; // REQUIRED!
      
      // Enable mutable-content flag so Notification Service Extension can modify the notification
      notification.mutableContent = 1;
      
      // Custom data for deep link (available in app)
      notification.payload = {
        roomId: roomId,
        type: 'presence',
        timestamp: Date.now()
      };

      // Set expiry (5 minutes - reasonable retry window)
      notification.expiry = Math.floor(Date.now() / 1000) + 300;
      
      // Priority 10 = immediate delivery (for presence notification)
      notification.priority = 10;

      // Push type (required for iOS 13+)
      notification.pushType = 'alert';

      console.log(`[APNs] 📤 Sending to ${deviceToken.substring(0, 16)}...`);
      console.log(`[APNs] Room: ${roomId}, Message: "${message}"`);

      // Send notification
      const result = await this.provider.send(notification, deviceToken);

      // Process response
      if (result.sent && result.sent.length > 0) {
        console.log(`[APNs] ✅ Sent successfully to ${result.sent.length} device(s)`);
        return { success: true, response: result };
      }

      if (result.failed && result.failed.length > 0) {
        const failure = result.failed[0];
        
        if (failure.error) {
          // Transport-level error (e.g., network)
          console.error('[APNs] ❌ Transport error:', failure.error.message);
          return { success: false, error: failure.error };
        } else {
          // APNs rejection (e.g., invalid/expired token)
          const reason = failure.response?.reason || 'Unknown';
          console.error('[APNs] ❌ Rejected:', failure.status, reason);
          
          // Return flag for token cleanup
          const shouldPurge = ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason);
          
          return { 
            success: false, 
            error: new Error(`APNs rejected: ${reason}`),
            shouldPurgeToken: shouldPurge,
            reason: reason
          };
        }
      }

      return { success: false, error: new Error('Unknown APNs error') };

    } catch (error) {
      console.error('[APNs] ❌ Exception during send:', error.message);
      return { success: false, error };
    }
  }

  /**
   * Gracefully shutdown APNs connection
   */
  async shutdown() {
    if (this.provider) {
      console.log('[APNs] Shutting down...');
      await this.provider.shutdown();
      this.isInitialized = false;
    }
  }
}

// Singleton instance
const apnsService = new APNsService();

// Graceful shutdown on process exit
process.on('SIGINT', async () => {
  await apnsService.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await apnsService.shutdown();
  process.exit(0);
});

module.exports = apnsService;
