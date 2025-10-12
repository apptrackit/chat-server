const admin = require('firebase-admin');
const path = require('path');

/**
 * FCM Service for Android Push Notifications
 * Uses Firebase Admin SDK for secure, scalable push delivery.
 * Designed to work alongside APNs for cross-platform support (iOS + Android).
 */
class FCMService {
  constructor() {
    this.app = null;
    this.isInitialized = false;
    this.init();
  }

  init() {
    try {
      const serviceAccountPath = process.env.FCM_SERVICE_ACCOUNT_PATH;

      // Gracefully disable if not configured (iOS-only deployment)
      if (!serviceAccountPath) {
        console.warn('[FCM] Missing FCM_SERVICE_ACCOUNT_PATH. Android push notifications disabled.');
        console.warn('[FCM] iOS notifications will still work via APNs.');
        return;
      }

      // Resolve key path relative to project root
      const absoluteServiceAccountPath = path.resolve(serviceAccountPath);

      // Initialize Firebase Admin SDK
      this.app = admin.initializeApp({
        credential: admin.credential.cert(absoluteServiceAccountPath)
      });

      this.isInitialized = true;
      console.log(`[FCM] ✅ Initialized successfully`);
      console.log(`[FCM] Service Account: ${serviceAccountPath}`);
    } catch (error) {
      console.error('[FCM] ❌ Initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Send presence notification to Android device
   * @param {string} deviceToken - FCM device token
   * @param {string} roomId - Room ID for deep link
   * @param {string} message - Notification message
   * @returns {Promise<{success: boolean, response?: object, error?: Error}>}
   */
  async sendPresenceNotification(deviceToken, roomId, message = 'Your chat partner is waiting') {
    if (!this.isInitialized || !this.app) {
      return { 
        success: false, 
        error: new Error('FCM not initialized'),
        skipped: true 
      };
    }

    // Validate token format (basic check - FCM tokens are typically 152+ chars)
    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length < 50) {
      console.error('[FCM] ❌ Invalid device token format:', deviceToken?.substring(0, 16));
      return { success: false, error: new Error('Invalid device token format') };
    }

    try {
      // Create FCM message payload
      const fcmMessage = {
        token: deviceToken,
        notification: {
          title: 'Chat Room Active',
          body: message
        },
        data: {
          type: 'presence',
          roomId: roomId,
          timestamp: Date.now().toString()
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'vortex_notifications',
            priority: 'high',
            defaultSound: true,
            defaultVibrateTimings: true
          }
        }
      };

      console.log(`[FCM] 📤 Sending to ${deviceToken.substring(0, 16)}...`);
      console.log(`[FCM] Room: ${roomId}, Message: "${message}"`);

      // Send notification via Firebase Admin SDK
      const response = await admin.messaging().send(fcmMessage);

      console.log(`[FCM] ✅ Sent successfully. Message ID: ${response}`);
      return { success: true, response: { messageId: response } };

    } catch (error) {
      console.error('[FCM] ❌ Failed to send:', error.message);
      
      // Check for invalid/expired token errors
      const errorCode = error.code;
      const shouldPurge = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
      ].includes(errorCode);
      
      if (shouldPurge) {
        console.warn(`[FCM] Token is invalid/expired: ${errorCode}`);
      }
      
      return { 
        success: false, 
        error: error,
        shouldPurgeToken: shouldPurge,
        reason: errorCode
      };
    }
  }

  /**
   * Gracefully shutdown FCM connection
   */
  async shutdown() {
    if (this.app) {
      console.log('[FCM] Shutting down...');
      await this.app.delete();
      this.isInitialized = false;
    }
  }
}

// Singleton instance
const fcmService = new FCMService();

// Graceful shutdown on process exit
process.on('SIGINT', async () => {
  await fcmService.shutdown();
});

process.on('SIGTERM', async () => {
  await fcmService.shutdown();
});

module.exports = fcmService;
