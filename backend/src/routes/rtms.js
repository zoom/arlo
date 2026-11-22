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
  broadcastRtmsRequestStatus,
  crossRegisterUser,
  getStats,
} = require('../services/websocket');
const { requireAuth } = require('../middleware/auth');
const { requireInternal, isInternalRequest, INTERNAL_KEY_HEADER, getInternalKey } = require('../lib/internalAuth');

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
    const plainToken = payload?.plainToken;
    if (typeof plainToken !== 'string' || plainToken.length === 0 || plainToken.length > 256) {
      return sendResponse(res, 400, { error: 'Invalid plainToken' });
    }
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

  // Why a stream request did not start (1-8, e.g. 3 = host denied). Zoom's docs
  // do not say whether this fires for in-client startRTMS or only REST requests,
  // so log the status code (never the ids) to find out.
  if (event === 'rtms.request_status') {
    const meetingUuid = payload?.id_field?.meeting_uuid ?? payload?.meeting_uuid;
    const status = payload?.status;
    const valid = typeof meetingUuid === 'string'
      && meetingUuid.length > 0 && meetingUuid.length <= 256
      && Number.isInteger(status) && status >= 1 && status <= 8;
    if (valid) {
      const sentCount = broadcastRtmsRequestStatus(meetingUuid, status);
      console.log(`rtms.request_status: status=${status}, delivered to ${sentCount} client(s)`);
    } else {
      // Field names only, so the real payload shape can be confirmed without logging values
      const fields = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20).join(',') : 'none';
      logger.warn(`rtms.request_status ignored: unexpected payload (fields: ${fields})`);
    }
    return sendResponse(res, 200, 'OK');
  }

  // Forward webhook to RTMS service (internal network only)
  if (event === 'meeting.rtms_started' || event === 'meeting.rtms_stopped') {
    try {
      const rtmsServiceUrl = process.env.RTMS_SERVICE_URL || 'http://rtms:3002';
      await axios.post(`${rtmsServiceUrl}/webhook`, body, {
        timeout: 5000,
        headers: {
          [INTERNAL_KEY_HEADER]: getInternalKey(),
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
const BROWSER_STATUSES = new Set(['rtms_paused', 'rtms_resumed']);
const INTERNAL_STATUSES = new Set([
  'rtms_started', 'rtms_stopped', 'rtms_paused', 'rtms_resumed',
  'rtms_interrupted', 'media_interrupted',
  'rtms_failed', // the rtms service could not join the stream Zoom started
]);

/**
 * Internal callers (rtms service) may post any lifecycle status. Browser callers
 * must be signed in and may only report pause/resume (the SDK pause/resume calls
 * happen client-side, so the backend learns about them from the browser).
 */
function authorizeStatusUpdate(req, res, next) {
  if (isInternalRequest(req)) {
    req.isInternal = true;
    return next();
  }
  return requireAuth(req, res, next);
}

router.post('/status', authorizeStatusUpdate, async (req, res) => {
  const { meetingId, status, operatorId } = req.body || {};

  if (typeof meetingId !== 'string' || meetingId.length === 0 || meetingId.length > 200) {
    return res.status(400).json({ error: 'Invalid meetingId' });
  }
  const allowed = req.isInternal ? INTERNAL_STATUSES : BROWSER_STATUSES;
  if (!allowed.has(status)) {
    return res.status(req.isInternal ? 400 : 403).json({ error: 'Status not allowed' });
  }

  console.log(`RTMS Status Update: ${status}`);

  // Cross-register user for WebSocket if we have an operator ID (internal only)
  if (req.isInternal && status === 'rtms_started' && operatorId) {
    // Find user by Zoom ID in memory store
    const user = userStore.findByZoomId(operatorId);
    if (user) {
      crossRegisterUser(user.id, meetingId);
      console.log('Cross-registered operator for RTMS meeting');
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
router.post('/broadcast', requireInternal, async (req, res) => {
  const { meetingId, segment } = req.body || {};
  if (typeof meetingId !== 'string' || !segment || typeof segment !== 'object') {
    return res.status(400).json({ error: 'Invalid broadcast payload' });
  }

  if (logger.isDebug) {
    console.log(`Transcript segment for meeting ${meetingId}:`, segment?.text?.substring(0, 50));
  }

  // Broadcast transcript segment to all WebSocket clients
  const sentCount = broadcastTranscriptSegment(meetingId, segment);
  logger.debug(`Broadcast transcript to ${sentCount} clients (demo mode - not stored)`);

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/participant-event
 * Receive participant join/leave events from RTMS service
 * No data is stored - broadcast only
 */
router.post('/participant-event', requireInternal, async (req, res) => {
  const { meetingId, events } = req.body || {};
  if (typeof meetingId !== 'string' || !Array.isArray(events)) {
    return res.status(400).json({ error: 'Invalid participant-event payload' });
  }

  logger.debug(`Participant events received: ${events.length}`);

  // Broadcast each event to WebSocket clients
  let sentCount = 0;
  for (const event of events) {
    sentCount += broadcastParticipantEvent(meetingId, event);
  }

  res.status(200).json({ received: true, broadcast: sentCount });
});

// Debug endpoints — explicit opt-in only (ENABLE_DEBUG_ROUTES=true). They list
// active meeting IDs, so they must never be reachable on a public URL by default.
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
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
