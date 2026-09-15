/**
 * RTMS Routes - Demo Mode
 *
 * SECURITY: Live transcription works via WebSocket broadcast.
 * No meeting data is ever persisted to a database.
 * All data exists only in memory during the active meeting.
 *
 * This module handles:
 * - Webhook verification from Zoom
 * - Forwarding webhooks to RTMS service
 * - Broadcasting transcript segments to WebSocket clients
 * - Broadcasting participant events to WebSocket clients
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();
const config = require('../config');
const logger = require('../lib/logger');
const { userStore } = require('../lib/memoryStore');
const {
  broadcastTranscriptSegment,
  broadcastParticipantEvent,
  broadcastMeetingStatus,
  crossRegisterUser,
  getStats,
} = require('../services/websocket');
const { requireAuth } = require('../middleware/auth');

// Demo mode - no persistence
console.log('Demo Mode: Transcripts are broadcast in real-time but never stored');

/**
 * Send a response and log it in debug mode
 */
function sendResponse(res, statusCode, body) {
  logger.debug('Response:', JSON.stringify({ status: statusCode, body }));
  if (typeof body === 'string') {
    return res.status(statusCode).send(body);
  }
  return res.status(statusCode).json(body);
}

/**
 * Verify Zoom webhook HMAC signature
 */
function verifyWebhookSignature(rawBody, timestamp, signature) {
  const secret = config.zoomWebhookToken;

  if (!secret) {
    console.error('ZOOM_WEBHOOK_TOKEN missing at runtime');
    return false;
  }

  if (!signature || !timestamp) {
    console.warn('Missing signature or timestamp headers');
    return false;
  }

  // Reject if timestamp is more than 5 minutes old (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const reqTimestamp = parseInt(timestamp, 10);
  if (isNaN(reqTimestamp) || Math.abs(now - reqTimestamp) > 300) {
    console.warn('Webhook timestamp too old or invalid');
    return false;
  }

  const message = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * POST /api/rtms/webhook
 * Receive RTMS webhooks from Zoom
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let body;
  let rawBodyStr;

  if (Buffer.isBuffer(req.body)) {
    rawBodyStr = req.body.toString('utf8');
    try {
      body = JSON.parse(rawBodyStr);
    } catch (e) {
      logger.error('Invalid JSON in webhook request');
      return sendResponse(res, 400, { error: 'Invalid JSON' });
    }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
    rawBodyStr = JSON.stringify(body);
  } else {
    logger.error('Empty or invalid webhook request body');
    return sendResponse(res, 400, { error: 'Invalid request body' });
  }

  const { event, payload } = body;

  // Handle Zoom webhook validation (endpoint URL validation)
  if (event === 'endpoint.url_validation') {
    const { plainToken } = payload;
    logger.info('Webhook validation request received');

    const hash = crypto
      .createHmac('sha256', config.zoomWebhookToken)
      .update(plainToken)
      .digest('hex');

    logger.info('Webhook validation response sent');
    return sendResponse(res, 200, { plainToken, encryptedToken: hash });
  }

  // Verify HMAC signature for all other events
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];

  const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(rawBodyStr, 'utf8');
  if (!verifyWebhookSignature(rawBodyBuffer, timestamp, signature)) {
    logger.error('Webhook signature verification failed');
    return sendResponse(res, 401, { error: 'Unauthorized' });
  }

  console.log(`RTMS Webhook: ${event} (signature verified)`);

  // Forward webhook to RTMS service (internal network only)
  if (event === 'meeting.rtms_started' || event === 'meeting.rtms_stopped') {
    try {
      const rtmsServiceUrl = process.env.RTMS_SERVICE_URL || 'http://rtms:3002';
      await axios.post(`${rtmsServiceUrl}/webhook`, body, {
        timeout: 5000,
        headers: {
          'x-arlo-internal': 'true',
          'x-zm-signature': signature,
          'x-zm-request-timestamp': timestamp,
        },
      });
      console.log(`Forwarded ${event} to RTMS service`);
    } catch (error) {
      console.error(`Failed to forward webhook to RTMS service:`, error.message);
    }
  }

  sendResponse(res, 200, 'OK');
});

/**
 * POST /api/rtms/status
 * Receive RTMS status updates from RTMS service
 */
router.post('/status', async (req, res) => {
  const { meetingId, status, meetingTopic, operatorId } = req.body;

  console.log(`RTMS Status Update: ${status} for meeting ${meetingId}`);

  // Cross-register user for WebSocket if we have an operator ID
  if (status === 'rtms_started' && operatorId) {
    // Find user by Zoom ID in memory store
    const user = userStore.findByZoomId(operatorId);
    if (user) {
      crossRegisterUser(user.id, meetingId);
      console.log(`Cross-registered user ${user.displayName} for meeting ${meetingId}`);
    }
  }

  // Broadcast status change to WebSocket clients
  const sentCount = broadcastMeetingStatus(meetingId, status);
  console.log(`Broadcast status to ${sentCount} clients`);

  // Broadcast transcription lifecycle event for timeline
  const lifecycleMap = {
    rtms_started: 'transcription_started',
    rtms_stopped: 'transcription_stopped',
    rtms_paused: 'transcription_paused',
    rtms_resumed: 'transcription_resumed',
  };
  const eventType = lifecycleMap[status];
  if (eventType) {
    broadcastParticipantEvent(meetingId, {
      eventType,
      participantName: 'Arlo',
      participantId: null,
      timestamp: Date.now(),
    });
  }

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/broadcast
 * Receive transcript segments from RTMS service to broadcast to clients
 * No data is stored - broadcast only
 */
router.post('/broadcast', async (req, res) => {
  const { meetingId, segment } = req.body;

  if (logger.isDebug) {
    console.log(`Transcript segment for meeting ${meetingId}:`, segment?.text?.substring(0, 50));
  }

  // Broadcast transcript segment to all WebSocket clients
  const sentCount = broadcastTranscriptSegment(meetingId, segment);
  console.log(`Broadcast transcript to ${sentCount} clients (demo mode - not stored)`);

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/participant-event
 * Receive participant join/leave events from RTMS service
 * No data is stored - broadcast only
 */
router.post('/participant-event', async (req, res) => {
  const { meetingId, events } = req.body;

  console.log(`Participant event for meeting ${meetingId}:`, events);

  // Broadcast each event to WebSocket clients
  let sentCount = 0;
  for (const event of events) {
    sentCount += broadcastParticipantEvent(meetingId, event);
  }

  res.status(200).json({ received: true, broadcast: sentCount });
});

// Debug endpoints — only available in non-production environments
if (process.env.NODE_ENV !== 'production') {
  router.get('/debug', (req, res) => {
    const stats = getStats();
    console.log('WebSocket Debug Stats:', stats);
    res.json({ ...stats, demoMode: true, persistence: 'disabled' });
  });

  router.post('/debug-meeting', (req, res) => {
    const { meetingId, source, fullContext } = req.body;
    console.log(`DEBUG: Meeting ID from ${source || 'unknown'}: "${meetingId}"`);
    res.json({ received: meetingId, demoMode: true });
  });
}

/**
 * POST /api/rtms/start
 * Start or stop RTMS via Zoom REST API
 * Note: This still works in demo mode as it calls Zoom's API directly
 */
router.post('/start', requireAuth, async (req, res) => {
  const { meetingId, meetingNumber, action = 'start' } = req.body;

  // In demo mode, we can't make Zoom API calls because we don't have stored tokens
  return res.json({
    demoMode: true,
    message: 'RTMS control via REST API is not available in demo mode. Use the Zoom SDK start/stop methods in the client instead.',
    available: false,
  });
});

module.exports = router;
