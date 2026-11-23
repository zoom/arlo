/**
 * RTMS Routes
 *
 * SECURITY: a meeting's transcript and timeline are held in memory while the
 * meeting runs (storage/) and deleted when it ends (services/meetingLifecycle.js).
 * Nothing is written to disk or a database, and nothing is logged.
 *
 * This module handles:
 * - Webhook verification from Zoom
 * - Forwarding webhooks to RTMS service
 * - Storing and broadcasting transcript segments
 * - Storing and broadcasting participant events
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
  broadcastArloState,
  broadcastRtmsRequestStatus,
  currentStreamStatus,
  disconnectUser,
  crossRegisterUser,
  getStats,
} = require('../services/websocket');
const { requireAuth } = require('../middleware/auth');
const { verifyMeetingAccessToken } = require('../services/zoomAppContext');
const { requireInternal, isInternalRequest, INTERNAL_KEY_HEADER, getInternalKey } = require('../lib/internalAuth');
const { getMeetingStore } = require('../storage');
const { getMeetingLifecycle } = require('../services/meetingLifecycle');
const { getMeetingStreams } = require('../services/meetingStreams');
const { getNotesEngine } = require('../services/notesEngine');

// RTMS stop reason 6: the stream ended because the meeting did
const RTMS_STOP_MEETING_ENDED = 6;

const MAX_ID_CHARS = 256;
const isStreamId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
/** A stream or operator id from the rtms service: left out, or a sane string. */
const isOptionalId = (value) => value === undefined || value === null || isStreamId(value);

/**
 * One stream of a meeting stopped, or never got in. A meeting can have several
 * streams (services/meetingStreams.js), so this is a meeting stop only when no
 * other stream is running. Returns true when it was the last one.
 */
function streamEnded(meetingId, streamId) {
  const streams = getMeetingStreams();
  const wasSource = streams.isSource(meetingId, streamId);
  if (!streams.streamStopped(meetingId, streamId).anyLive) return true;
  // The transcript now comes from another stream. The panels may have been
  // told the old one was reconnecting: for them a stream is running.
  if (wasSource) broadcastMeetingStatus(meetingId, 'rtms_started');
  return false;
}

/**
 * A stop or failed-join report for a stream. Returns what it means for the
 * meeting:
 *   'over'  Zoom says the meeting itself ended (stop reason 6). Whichever
 *           stream the report came on, every stream of the meeting is over:
 *           the panels are told and the meeting's data is flushed.
 *   'last'  the meeting's last running stream stopped: a meeting stop.
 *   'quiet' nothing changes for the meeting: another stream is still running,
 *           or the meeting ended a moment ago and this is the report for one
 *           of its other streams.
 */
function stopReported(meetingId, streamId, meetingEnded) {
  if (getMeetingLifecycle().hasEnded(meetingId)) return 'quiet';
  if (meetingEnded === true) {
    getMeetingStreams().stopAll(meetingId);
    return 'over';
  }
  return streamEnded(meetingId, streamId) ? 'last' : 'quiet';
}

/**
 * Whether a line (`line` given) or a timeline event from this stream is kept:
 * see acceptsDataFrom() in services/meetingStreams.js. `stream` is what the
 * rtms service says with it: { streamId, operatorId, originalHost }. Answers
 * false for a meeting that was flushed a moment ago, before anything is noted
 * about its streams, so nothing about a meeting comes back after its flush.
 */
function keepsDataFrom(meetingId, { streamId, operatorId, originalHost }, line) {
  const lifecycle = getMeetingLifecycle();
  if (!lifecycle.dataReceived(meetingId)) return false;
  const streams = getMeetingStreams();
  const wasSource = streams.isSource(meetingId, streamId);
  const operatorsBefore = streams.operators(meetingId).length;
  const kept = streams.acceptsDataFrom(meetingId, streamId, {
    ...(line !== undefined && { line }),
    operatorId,
    originalHost: originalHost === true,
  });
  const told = currentStreamStatus(meetingId);
  const learnedRunning = told === null && streams.anyLive(meetingId);
  // This stream just took over from one that went silent without a stop
  // report, and the panels were told the old one was reconnecting: for them a
  // stream is running again.
  const tookOver = told === 'rtms_interrupted' && !wasSource && streams.isSource(meetingId, streamId);
  if (learnedRunning) {
    // A stream is running that nobody announced: this server restarted
    // mid-meeting and learned it from its data. The lifecycle, the panels and
    // the timeline get what the lost start report would have given them.
    // Once: from here on the meeting has a status.
    lifecycle.streamStatus(meetingId, 'rtms_started');
    // eslint-disable-next-line no-use-before-define
    recordParticipantEvent(meetingId, {
      eventType: 'transcription_started', participantName: 'Arlo', participantId: null, timestamp: Date.now(),
    });
    const operator = isStreamId(operatorId) ? userStore.findByZoomId(operatorId) : null;
    if (operator) crossRegisterUser(operator.id, meetingId);
    console.log('A running stream was learned from its data: the meeting is marked as running');
  }
  if (learnedRunning || tookOver) broadcastMeetingStatus(meetingId, 'rtms_started');
  // Each panel learns what it is to Arlo now: whose stream is stored may have
  // changed, or whose stream this is was not known until now (that person
  // brought Arlo in too)
  if (learnedRunning || tookOver || streams.operators(meetingId).length !== operatorsBefore) {
    broadcastArloState(meetingId);
  }
  return kept;
}

/**
 * Keep a timeline event for the meeting, then send the stored copy (it has the
 * id). Nothing is kept or sent for a meeting that was flushed a moment ago.
 */
function recordParticipantEvent(meetingId, event) {
  if (!getMeetingLifecycle().dataReceived(meetingId)) return 0;
  const stored = getMeetingStore().appendEvent(meetingId, event);
  return stored ? broadcastParticipantEvent(meetingId, stored) : 0;
}

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

  // Forward the stream lifecycle to the RTMS service (internal network only).
  // It owns the connection: it joins on started, leaves on stopped, and on
  // interrupted (Zoom lost the signaling connection) it rejoins within Zoom's
  // ~60s window and reports "interrupted" / "reconnected" itself.
  const FORWARDED = ['meeting.rtms_started', 'meeting.rtms_stopped', 'meeting.rtms_interrupted'];
  if (FORWARDED.includes(event)) {
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
      // Nobody is left to report the interruption, so tell the meeting from here:
      // the panel shows "Reconnecting…" instead of a silent stall.
      const meetingUuid = payload?.meeting_uuid;
      const validUuid = typeof meetingUuid === 'string' && meetingUuid.length > 0 && meetingUuid.length <= 256;
      // Which stream Zoom means. An id that is not a sane string is not used:
      // the webhook is then about the meeting's stream, as before streams were told apart.
      const streamId = isStreamId(payload?.rtms_stream_id) ? payload.rtms_stream_id : undefined;
      const streams = getMeetingStreams();
      const aboutAnotherStream = validUuid && streamId !== undefined
        && streams.anyLive(meetingUuid) && !streams.isSource(meetingUuid, streamId);
      if (event === 'meeting.rtms_interrupted' && validUuid && !aboutAnotherStream) {
        broadcastMeetingStatus(meetingUuid, 'rtms_interrupted');
      }
      // A stop the rtms service never hears about would never be reported back,
      // so the meeting's data would stay in memory after the meeting. Zoom's
      // signed webhook is enough to act on: tell the panels and the lifecycle,
      // once the meeting's last stream has stopped, or at once when the stop
      // says the meeting itself ended.
      if (event === 'meeting.rtms_stopped' && validUuid) {
        const meetingEnded = payload.stop_reason === RTMS_STOP_MEETING_ENDED;
        if (stopReported(meetingUuid, streamId, meetingEnded) !== 'quiet') {
          broadcastMeetingStatus(meetingUuid, 'rtms_stopped', { meetingEnded });
          getMeetingLifecycle().streamStatus(meetingUuid, 'rtms_stopped', { meetingEnded });
        }
      }
      if (validUuid) broadcastArloState(meetingUuid);
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
  'rtms_reconnected', // the rtms service rejoined the stream after an interruption
  'rtms_failed', // the rtms service could not join the stream Zoom started
]);

/**
 * Internal callers (rtms service) may post any lifecycle status. Browser callers
 * must be signed in and may only report pause/resume (the SDK pause/resume calls
 * happen client-side, so the backend learns about them from the browser), and
 * only for the meeting they were verified to be in: see inMeeting().
 */
const STREAM_RUNNING = new Set(['rtms_started', 'rtms_reconnected']);
const STREAM_ENDED = new Set(['rtms_stopped', 'rtms_failed']);

function authorizeStatusUpdate(req, res, next) {
  if (isInternalRequest(req)) {
    req.isInternal = true;
    return next();
  }
  return requireAuth(req, res, next);
}

/**
 * Whether the caller's meeting-access cookie (issued from the Zoom App Context,
 * the same proof that opens the WebSocket) names exactly this meeting. Being
 * signed in does not replace it.
 */
function inMeeting(req, meetingId) {
  const token = req.cookies?.meetingAccess;
  if (typeof token !== 'string' || token.length === 0) return false;
  try {
    return verifyMeetingAccessToken(token).meetingId === meetingId;
  } catch {
    return false;
  }
}

router.post('/status', authorizeStatusUpdate, async (req, res) => {
  const {
    meetingId, status, streamId, operatorId, originalHost, fault, meetingEnded,
  } = req.body || {};

  if (typeof meetingId !== 'string' || meetingId.length === 0 || meetingId.length > 200) {
    return res.status(400).json({ error: 'Invalid meetingId' });
  }
  const allowed = req.isInternal ? INTERNAL_STATUSES : BROWSER_STATUSES;
  if (!allowed.has(status)) {
    return res.status(req.isInternal ? 400 : 403).json({ error: 'Status not allowed' });
  }

  if (req.isInternal && (!isOptionalId(streamId) || !isOptionalId(operatorId))) {
    return res.status(400).json({ error: 'Invalid streamId or operatorId' });
  }
  // A browser names its own meetingId: without this check a signed-in user
  // could show "paused" to the panels of any meeting whose UUID they know
  if (!req.isInternal && !inMeeting(req, meetingId)) {
    return res.status(403).json({ error: 'Forbidden', message: 'Not a participant of this meeting' });
  }
  // A Zoom meeting UUID that ended does not start again. A start or rejoin
  // report for one (it was on its way, or a rejoin got in as the meeting
  // closed) is answered and otherwise ignored: nothing about the meeting
  // comes back after its flush.
  if (req.isInternal && STREAM_RUNNING.has(status) && getMeetingLifecycle().hasEnded(meetingId)) {
    return res.status(200).json({ received: true, broadcast: 0 });
  }

  console.log(`RTMS Status Update: ${status}`);

  // A meeting can have several streams, one per user who started one. The rtms
  // service reports each; the meeting as a whole (its panels, its timeline, its
  // data lifecycle) only hears what changes for the meeting:
  //   - a stream starting or rejoining, unless another stream is the one stored,
  //   - a stream stopping or failing, only when it was the last one running,
  //   - a stop because the meeting itself ended, on whichever stream it is
  //     reported first: every stream is over (`meetingIsOver`),
  //   - an interruption, only on the stream that is stored.
  // `quiet` marks a report that changes nothing for the meeting.
  const streams = getMeetingStreams();
  let quiet = false;
  let firstStream = false;
  let meetingIsOver = false;
  if (req.isInternal) {
    if (STREAM_RUNNING.has(status)) {
      firstStream = !streams.anyLive(meetingId);
      streams.streamStarted(meetingId, {
        streamId, operatorId, originalHost: originalHost === true,
      });
      quiet = !firstStream && !streams.isSource(meetingId, streamId);
    } else if (STREAM_ENDED.has(status)) {
      const meaning = stopReported(meetingId, streamId, status === 'rtms_stopped' && meetingEnded === true);
      quiet = meaning === 'quiet';
      meetingIsOver = meaning === 'over';
    } else {
      quiet = isStreamId(streamId) && streams.anyLive(meetingId) && !streams.isSource(meetingId, streamId);
    }
  }

  // The meeting's data lifecycle (services/meetingLifecycle.js) follows the rtms
  // service's reports only: a browser cannot start a flush or hold data back.
  // "The meeting ended" is applied last, after the meeting has been told. A
  // fault counts for the meeting's last stream only.
  const lifecycle = getMeetingLifecycle();
  if (req.isInternal && !quiet && !meetingIsOver) lifecycle.streamStatus(meetingId, status);

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
  const ARLO_EVENTS = {
    rtms_started: 'arlo.stream_joined',
    rtms_reconnected: 'arlo.stream_rejoined',
    rtms_failed: 'arlo.join_failed',
    media_interrupted: 'arlo.media_interrupted',
  };
  if (req.isInternal && ARLO_EVENTS[status]) {
    rtmsEvents.record({ event: ARLO_EVENTS[status], meetingUuid: meetingId });
  }

  if (quiet) {
    // The meeting's status is unchanged, but a stream starting or stopping can
    // change what one person is to Arlo (they brought it in too)
    broadcastArloState(meetingId);
    return res.status(200).json({ received: true, broadcast: 0 });
  }

  // Broadcast status change to WebSocket clients. A rejoined stream is a running
  // stream to them. `fault` (from the rtms service only) marks a stream Zoom
  // ended because of a connection problem, so the panel can offer a restart.
  const clientStatus = status === 'rtms_reconnected' ? 'rtms_started' : status;
  const endedByFault = req.isInternal && status === 'rtms_stopped' && fault === true;
  const sentCount = broadcastMeetingStatus(meetingId, clientStatus, { fault: endedByFault, meetingEnded: meetingIsOver });
  console.log(`Broadcast status to ${sentCount} clients`);

  // Broadcast transcription lifecycle event for timeline
  const lifecycleMap = {
    rtms_started: 'transcription_started',
    rtms_stopped: 'transcription_stopped',
    rtms_paused: 'transcription_paused',
    rtms_resumed: 'transcription_resumed',
  };
  // "Transcription started" is one line for the meeting, not one per stream
  const anotherStreamStarted = req.isInternal && status === 'rtms_started' && !firstStream;
  const eventType = anotherStreamStarted ? null : lifecycleMap[status];
  if (eventType) {
    const event = { eventType, participantName: 'Arlo', participantId: null, timestamp: Date.now() };
    // Only the rtms service's reports are kept. A browser names its own
    // meetingId here, so its pause/resume report is passed on but not stored.
    if (req.isInternal) recordParticipantEvent(meetingId, event);
    else broadcastParticipantEvent(meetingId, event);
  }

  if (meetingIsOver) lifecycle.streamStatus(meetingId, status, { meetingEnded: true });

  // Each panel learns what it is to Arlo now. Last, so it is the state after
  // the change: after a meeting ended that is "not here, and nobody's notes".
  broadcastArloState(meetingId);

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/broadcast
 * A transcript segment from the RTMS service: kept for the meeting (in memory,
 * until the meeting ends) and sent to the panels connected to it.
 */
router.post('/broadcast', requireInternal, async (req, res) => {
  const {
    meetingId, segment, streamId, operatorId, originalHost,
  } = req.body || {};
  if (typeof meetingId !== 'string' || !segment || typeof segment !== 'object'
      || !isOptionalId(streamId) || !isOptionalId(operatorId)) {
    return res.status(400).json({ error: 'Invalid broadcast payload' });
  }

  if (typeof segment.text !== 'string' || segment.text.length === 0) {
    return res.status(400).json({ error: 'Invalid segment' });
  }
  // Dropped: a line still in flight for a meeting whose data was just flushed,
  // a line from a stream other than the one the transcript is taken from, and
  // a line that is stored already (each user's stream carries the same speech;
  // one copy is kept). The line's own fields decide what a duplicate is.
  const line = { speakerId: segment.speakerId, tStartMs: segment.tStartMs, text: segment.text };
  if (!keepsDataFrom(meetingId, { streamId, operatorId, originalHost }, line)) {
    return res.status(200).json({ received: true, stored: false, broadcast: 0 });
  }
  const stored = getMeetingStore().appendSegment(meetingId, segment);
  if (!stored) {
    return res.status(400).json({ error: 'Invalid segment' });
  }
  const sentCount = broadcastTranscriptSegment(meetingId, stored);
  logger.debug(`Transcript segment kept and sent to ${sentCount} client(s)`);
  // The live notes are written from the stored lines, on the engine's own clock
  getNotesEngine().segmentStored(meetingId);

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/participant-event
 * Receive participant join/leave events from RTMS service
 * Kept for the meeting (in memory) and sent to its panels
 */
router.post('/participant-event', requireInternal, async (req, res) => {
  const {
    meetingId, events, streamId, operatorId, originalHost,
  } = req.body || {};
  if (typeof meetingId !== 'string' || !Array.isArray(events)
      || !isOptionalId(streamId) || !isOptionalId(operatorId)) {
    return res.status(400).json({ error: 'Invalid participant-event payload' });
  }

  logger.debug(`Participant events received: ${events.length}`);
  // Every stream of a meeting reports the same people: one stream's are kept
  if (!keepsDataFrom(meetingId, { streamId, operatorId, originalHost })) {
    return res.status(200).json({ received: true, stored: false, broadcast: 0 });
  }

  // Broadcast each event to WebSocket clients
  let sentCount = 0;
  for (const event of events.slice(0, 200)) {
    sentCount += recordParticipantEvent(meetingId, event);
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
