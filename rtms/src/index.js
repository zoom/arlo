require('dotenv').config({ path: '../../.env' });

// The RTMS SDK expects ZM_RTMS_* names; map from the shared ZOOM_* creds when unset.
if (process.env.ZOOM_CLIENT_ID && !process.env.ZM_RTMS_CLIENT) {
  process.env.ZM_RTMS_CLIENT = process.env.ZOOM_CLIENT_ID;
}
if (process.env.ZOOM_CLIENT_SECRET && !process.env.ZM_RTMS_SECRET) {
  process.env.ZM_RTMS_SECRET = process.env.ZOOM_CLIENT_SECRET;
}
// Compose BACKEND_URL from host/port when only those are provided (multi-service deploys).
if (!process.env.BACKEND_URL && process.env.BACKEND_HOST && process.env.BACKEND_PORT) {
  process.env.BACKEND_URL = `http://${process.env.BACKEND_HOST}:${process.env.BACKEND_PORT}`;
}

const express = require('express');
const crypto = require('crypto');
const rtmsModule = require('@zoom/rtms');
const rtms = rtmsModule.default; // ES module default export
const axios = require('axios');
const { createSessionManager } = require('./sessions');

// Logging is now configured via ZM_RTMS_LOG_LEVEL env var (e.g. "debug")

const app = express();

// Webhook Secret Token for HMAC signature verification
// This is the "Secret Token" from Zoom Marketplace → App → Feature → Event Subscriptions
// NOT the same as ZOOM_CLIENT_SECRET (which is for OAuth)
const WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_TOKEN;

if (!WEBHOOK_SECRET) {
  console.error('❌ FATAL: ZOOM_WEBHOOK_TOKEN is not configured');
  console.error('   This is the "Secret Token" from Zoom Marketplace:');
  console.error('   App → Feature → Event Subscriptions → Secret Token');
  console.error('   (This is NOT the same as ZOOM_CLIENT_SECRET which is for OAuth)');
  process.exit(1);
}

// Internal service-to-service key (must match backend/src/lib/internalAuth.js).
// INTERNAL_API_SECRET if set, otherwise derived from ZOOM_WEBHOOK_TOKEN.
const INTERNAL_KEY_HEADER = 'x-arlo-internal-key';
const INTERNAL_KEY = process.env.INTERNAL_API_SECRET
  || crypto.createHmac('sha256', WEBHOOK_SECRET).update('arlo-internal-v1').digest('hex');

function isInternalRequest(req) {
  const provided = req.headers[INTERNAL_KEY_HEADER];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(INTERNAL_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

const internalHttp = axios.create({
  timeout: 5000,
  headers: { [INTERNAL_KEY_HEADER]: INTERNAL_KEY },
});

// This service never logs transcript text, names or webhook payloads, at any
// log level. ZM_RTMS_LOG_LEVEL controls the @zoom/rtms SDK's own logging; keep
// it at info, since the SDK's debug output is outside this service's control.

/**
 * Verify Zoom webhook HMAC signature
 * @param {object} req - Express request object
 * @param {string|Buffer} rawBody - Raw request body (string or buffer)
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(req, rawBody) {
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];

  // WEBHOOK_SECRET is validated at startup, no need to check again here

  if (!signature || !timestamp) {
    console.warn('Missing signature or timestamp headers');
    return false;
  }

  // Reject if timestamp is more than 5 minutes old (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const reqTimestamp = parseInt(timestamp, 10);
  if (isNaN(reqTimestamp) || Math.abs(now - reqTimestamp) > 300) {
    console.warn('Webhook timestamp too old or invalid — possible replay attack');
    return false;
  }

  // Use raw body string for signature computation
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const message = `v0:${timestamp}:${bodyStr}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(message)
    .digest('hex');

  // Length check before timing-safe comparison (prevents timingSafeEqual from throwing)
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Middleware - capture raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Session lifecycle lives in ./sessions.js (tested with a fake client). This
// file only wires it to the real Zoom SDK client, the backend and the webhook.
// CHAOS_DROP_STREAM_AFTER_SEC (testing only, off by default): drop the stream
// connection that many seconds after each join, to watch the reconnection flow
// in a real meeting. Modelled on Zoom's reconnection_and_chaos_mode_js sample.
const chaosSeconds = Number.parseInt(process.env.CHAOS_DROP_STREAM_AFTER_SEC || '0', 10);
const CHAOS_DROP_AFTER_MS = Number.isInteger(chaosSeconds) && chaosSeconds > 0 && chaosSeconds <= 3600
  ? chaosSeconds * 1000
  : 0;
if (CHAOS_DROP_AFTER_MS > 0) {
  console.warn(`CHAOS MODE: every stream connection is dropped ${chaosSeconds}s after it joins`);
}

const sessions = createSessionManager({
  createClient: () => new rtms.Client(),
  chaosDropAfterMs: CHAOS_DROP_AFTER_MS,
  backend: {
    status: notifyBackend,
    segment: broadcastSegment,
    participantEvents: broadcastParticipantEvents,
  },
});

// Remove sessions older than 24 hours (prevents unbounded growth)
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const swept = sessions.sweep();
  if (swept > 0) {
    console.log(`TTL sweep: removed ${swept} stale session(s), ${sessions.size()} remaining`);
  }
}, SESSION_SWEEP_INTERVAL_MS).unref();

// =============================================================================
// RTMS WEBHOOK HANDLER
// =============================================================================

/**
 * POST /webhook
 * Receive RTMS webhooks from Zoom (or forwarded from backend)
 */
app.post('/webhook', async (req, res) => {
  const { event, payload, event_ts: eventTs } = req.body;

  // Skip HMAC verification for:
  // - endpoint.url_validation (uses its own CRC mechanism)
  // - Requests forwarded from the backend, already verified against Zoom's
  //   original body bytes. Axios re-serializes the parsed JSON so a second
  //   HMAC here would fail on the reserialized body.
  const isInternal = isInternalRequest(req);
  if (event !== 'endpoint.url_validation' && !isInternal) {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(req, rawBody)) {
      console.error('Webhook signature verification failed');
      return res.status(401).send('Unauthorized');
    }
  }

  console.log('='.repeat(60));
  console.log(`RTMS Webhook Received: ${event} (${isInternal ? 'forwarded by the backend' : 'signature verified'})`);
  console.log('='.repeat(60));
  // Acknowledge webhook immediately
  res.status(200).send('OK');

  try {
    switch (event) {
      case 'meeting.rtms_started':
        await sessions.started(payload);
        break;

      case 'meeting.rtms_stopped':
        await sessions.stopped(payload);
        break;

      case 'meeting.rtms_interrupted':
        // Signaling dropped: rejoin within Zoom's ~60s window
        await sessions.interrupted(payload, eventTs);
        break;

      default:
        console.log(`Unhandled webhook event: ${event}`);
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
  }
});

/**
 * Broadcast segment to WebSocket clients via backend
 */
async function broadcastSegment(meetingId, segment) {
  try {
    // Use Docker service name for inter-container communication
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    await internalHttp.post(`${backendUrl}/api/rtms/broadcast`, {
      meetingId,
      segment,
    });
  } catch (error) {
    // Non-critical, just log
    console.warn('Failed to broadcast segment:', error.message);
  }
}

/**
 * Broadcast participant events to frontend via backend
 */
async function broadcastParticipantEvents(meetingId, events) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    await internalHttp.post(`${backendUrl}/api/rtms/participant-event`, {
      meetingId,
      events,
    });
    console.log(`Sent ${events.length} participant events to backend for broadcast`);
  } catch (error) {
    console.warn('Failed to broadcast participant events:', error.message);
  }
}

/**
 * Notify backend of RTMS status change
 */
async function notifyBackend(meetingId, status, { operatorId, fault } = {}) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    await internalHttp.post(`${backendUrl}/api/rtms/status`, {
      meetingId,
      status,
      ...(operatorId && { operatorId }),
      ...(fault === true && { fault: true }),
    });
    console.log(`Notified backend: ${status}`);
  } catch (error) {
    console.warn('Failed to notify backend:', error.message);
  }
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size(),
  });
});

// =============================================================================
// START SERVER
// =============================================================================

// Prefer PORT (platform-assigned) over RTMS_PORT (local/docker default).
const PORT = process.env.PORT || process.env.RTMS_PORT || 3002;

// Bind all interfaces so the process is reachable from other containers/services.
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('Arlo Meeting Assistant RTMS Service');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Webhook Auth: ZOOM_WEBHOOK_TOKEN`);
  console.log('='.repeat(60));
  console.log('Waiting for RTMS webhooks from Zoom...');
  console.log('='.repeat(60));
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received. Closing RTMS sessions...`);
  sessions.closeAll();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
