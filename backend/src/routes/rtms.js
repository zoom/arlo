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
const deauthorized = require('../lib/deauthorized');
const apiTokens = require('../lib/apiTokens');
const rtmsEvents = require('../lib/rtmsEvents');
const { zoomCall } = require('../services/zoomApi');
const { sessionOrToken } = require('../middleware/apiToken');
const {
  broadcastTranscriptSegment,
  broadcastParticipantEvent,
  broadcastMeetingStatus,
  broadcastRtmsRequestStatus,
  disconnectUser,
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
  logger.debug('Response status:', statusCode);
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
    // Already parsed by the global JSON parser, which kept the original bytes
    body = req.body;
    rawBodyStr = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
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

  // Verify against the bytes Zoom sent, never a re-serialized copy. Without
  // those bytes the signature cannot be checked, so the request is refused.
  const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
  if (!Buffer.isBuffer(rawBodyBuffer) || !verifyWebhookSignature(rawBodyBuffer, timestamp, signature)) {
    logger.error('Webhook signature verification failed');
    return sendResponse(res, 401, { error: 'Unauthorized' });
  }

  console.log(`RTMS Webhook: ${event} (signature verified)`);

  // Timeline for RTMS workflow testing (GET /api/rtms/events)
  if (typeof event === 'string' && (event.startsWith('meeting.rtms_') || event.startsWith('rtms.'))) {
    rtmsEvents.recordWebhook(event, payload);
  }

  // The user removed the app from their Zoom account. Delete what the server
  // holds for them and end their session. (Set the Marketplace
  // "Deauthorization Notification Endpoint URL" to this webhook URL.)
  if (event === 'app_deauthorized') {
    const zoomUserId = payload?.user_id;
    const forThisApp = payload?.client_id === config.zoomClientId;
    if (forThisApp && typeof zoomUserId === 'string' && zoomUserId.length > 0 && zoomUserId.length <= 200) {
      deauthorized.mark(zoomUserId);
      rtmsEvents.forgetUser(zoomUserId);
      const user = userStore.findByZoomId(zoomUserId);
      if (user) {
        disconnectUser(user.id);
        apiTokens.revokeAllFor(user.id);
        userStore.delete(user.id); // also deletes their OAuth tokens
      }
      console.log(`app_deauthorized: user data removed (${user ? 'user was in memory' : 'no data held'})`);
    } else {
      logger.warn('app_deauthorized ignored: not for this app or unexpected payload');
    }
    return sendResponse(res, 200, 'OK');
  }

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

  // Zoom lost the signaling connection for this stream. Tell the meeting so the
  // panel shows "Reconnecting…" instead of a silent stall. The rtms service is
  // deliberately NOT told to drop its session here: whether the app or the
  // @zoom/rtms SDK must reconnect, and how failover is signalled for meetings,
  // is not settled by Zoom's docs. A later rtms_started, rtms_stopped or
  // transcript line moves the state on.
  if (event === 'meeting.rtms_interrupted') {
    const meetingUuid = payload?.meeting_uuid;
    if (typeof meetingUuid === 'string' && meetingUuid.length > 0 && meetingUuid.length <= 256) {
      const sentCount = broadcastMeetingStatus(meetingUuid, 'rtms_interrupted');
      console.log(`meeting.rtms_interrupted: delivered to ${sentCount} client(s)`);
    } else {
      logger.warn('meeting.rtms_interrupted ignored: unexpected payload');
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

  // Timeline: what Arlo's own connection to the stream did
  const ARLO_EVENTS = { rtms_started: 'arlo.stream_joined', rtms_failed: 'arlo.join_failed', media_interrupted: 'arlo.media_interrupted' };
  if (req.isInternal && ARLO_EVENTS[status]) {
    rtmsEvents.record({ event: ARLO_EVENTS[status], meetingUuid: meetingId });
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
const REST_ACTIONS = new Set(['start', 'stop', 'pause', 'resume']);
// Numeric meeting IDs and meeting UUIDs (base64): nothing that could alter the path
const MEETING_ID_PATTERN = /^[A-Za-z0-9+/=_-]{1,200}$/;

/** Zoom requires a meeting UUID to be double URL-encoded when it contains '/'. */
function encodeMeetingId(id) {
  const once = encodeURIComponent(id);
  return id.includes('/') ? encodeURIComponent(once) : once;
}

router.post('/start', sessionOrToken('rtms:control'), async (req, res) => {
  const { meetingId, meetingNumber, action = 'start' } = req.body || {};
  // Zoom's live-meeting endpoint takes the numeric meeting ID; prefer it over the UUID
  const target = [meetingNumber, meetingId]
    .map((value) => (typeof value === 'number' ? String(value) : value))
    .find((value) => typeof value === 'string' && value.length > 0);

  if (!REST_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Invalid request', message: 'action must be start, stop, pause or resume' });
  }
  if (typeof target !== 'string' || !MEETING_ID_PATTERN.test(target)) {
    return res.status(400).json({ error: 'Invalid request', message: 'meetingId must be a Zoom meeting ID or UUID' });
  }

  let result;
  try {
    // PATCH /v2/live_meetings/{meetingId}/rtms_app/status
    // (scope: meeting:update:participant_rtms_app_status)
    result = await zoomCall(req.user.id, 'PATCH', `/live_meetings/${encodeMeetingId(target)}/rtms_app/status`, {
      action,
      settings: { client_id: config.zoomClientId },
    });
  } catch (error) {
    if (error.code === 'no_token' || error.code === 'refresh_failed') {
      return res.status(409).json({
        error: 'no_zoom_token',
        message: 'Arlo has no usable Zoom token for you. Sign in to Arlo again, then retry.',
      });
    }
    console.error('REST RTMS control failed:', error.code || error.message);
    return res.status(502).json({ error: 'zoom_unreachable', message: 'Zoom did not answer.' });
  }

  const zoom = {
    status: result.status,
    ...(result.body?.code !== undefined && { code: result.body.code }),
    ...(typeof result.body?.message === 'string' && { message: result.body.message.slice(0, 500) }),
  };
  rtmsEvents.record({
    event: 'rest.request',
    zoomUserId: req.user.zoomUserId,
    detail: {
      action,
      meetingId: target,
      accepted: result.ok,
      zoomStatus: result.status,
      ...(zoom.code !== undefined && { zoomCode: zoom.code }),
      ...(zoom.message && { zoomMessage: zoom.message }),
    },
  });
  console.log(`REST RTMS ${action}: Zoom answered ${result.status}`);

  if (result.ok) {
    return res.status(202).json({
      accepted: true,
      action,
      note: 'Zoom accepted the request. That does not mean the stream started: the host may still have to approve it. Watch GET /api/rtms/events.',
    });
  }
  // Zoom's own refusal is passed on with its status, except 401: to this API's
  // callers 401 means "your Arlo credential is bad", which it is not.
  const status = result.status >= 400 && result.status < 500 && result.status !== 401 ? result.status : 502;
  return res.status(status).json({ accepted: false, action, zoom });
});

/**
 * GET /api/rtms/events
 * Timeline of RTMS events for the caller's own meetings: REST requests made
 * through this proxy, Zoom's webhooks, and Arlo's own stream connection.
 * Optional ?since=<ISO time> returns only later entries. See lib/rtmsEvents.js.
 */
router.get('/events', sessionOrToken('rtms:read'), (req, res) => {
  let since = 0;
  if (req.query.since !== undefined) {
    since = typeof req.query.since === 'string' ? Date.parse(req.query.since) : NaN;
    if (Number.isNaN(since)) {
      return res.status(400).json({ error: 'Invalid request', message: 'since must be an ISO 8601 time' });
    }
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ events: rtmsEvents.list(req.user.zoomUserId, { since }) });
});

module.exports = router;
