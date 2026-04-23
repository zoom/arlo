require('dotenv').config({ path: '../../.env' });
const express = require('express');
const crypto = require('crypto');
const rtmsModule = require('@zoom/rtms');
const rtms = rtmsModule.default; // ES module default export
const axios = require('axios');

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

// Store active RTMS sessions — keyed by rtms_stream_id for proper failover handling
// Each meeting gets its own Client instance
const activeSessions = new Map();

// TTL sweep: Remove stale sessions older than 24 hours (prevents unbounded growth)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [streamId, session] of activeSessions) {
    if (now - session.startTime.getTime() > SESSION_TTL_MS) {
      console.log(`Sweeping stale session: ${streamId} (age > 24h)`);
      try {
        session.client.leave();
      } catch (e) {
        // Ignore leave errors for stale sessions
      }
      activeSessions.delete(streamId);
      swept++;
    }
  }
  if (swept > 0) {
    console.log(`TTL sweep: removed ${swept} stale session(s), ${activeSessions.size} remaining`);
  }
}, SESSION_SWEEP_INTERVAL_MS);

// =============================================================================
// RTMS WEBHOOK HANDLER
// =============================================================================

/**
 * POST /webhook
 * Receive RTMS webhooks from Zoom (or forwarded from backend)
 */
app.post('/webhook', async (req, res) => {
  const { event, payload } = req.body;

  // Skip HMAC verification for:
  // - endpoint.url_validation (uses its own CRC mechanism)
  // - Requests forwarded from the backend, already verified against Zoom's
  //   original body bytes. Axios re-serializes the parsed JSON so a second
  //   HMAC here would fail on the reserialized body.
  const isInternal = req.headers['x-arlo-internal'] === 'true';
  if (event !== 'endpoint.url_validation' && !isInternal) {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(req, rawBody)) {
      console.error('Webhook signature verification failed');
      return res.status(401).send('Unauthorized');
    }
  }

  console.log('='.repeat(60));
  console.log(`RTMS Webhook Received: ${event} (signature verified)`);
  console.log('='.repeat(60));
  // Only log payload details in debug mode to avoid PII exposure
  if (process.env.LOG_LEVEL === 'debug' || process.env.ZM_RTMS_LOG_LEVEL === 'debug') {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Meeting UUID: ${payload?.meeting_uuid || 'N/A'}`);
  }

  // Acknowledge webhook immediately
  res.status(200).send('OK');

  try {
    switch (event) {
      case 'meeting.rtms_started':
        await handleRTMSStarted(payload);
        break;

      case 'meeting.rtms_stopped':
        await handleRTMSStopped(payload);
        break;

      case 'meeting.rtms_interrupted':
        await handleRTMSInterrupted(payload);
        break;

      default:
        console.log(`Unhandled webhook event: ${event}`);
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
  }
});

/**
 * Handle RTMS started event — creates a new Client per stream
 *
 * Sessions are keyed by rtms_stream_id (not meeting_uuid) to properly handle:
 * - Server failover: same meeting_uuid, new rtms_stream_id → new session
 * - True duplicates: same rtms_stream_id → ignore
 */
async function handleRTMSStarted(payload) {
  const {
    meeting_uuid,
    rtms_stream_id,
    server_urls,
    operator_id
  } = payload;

  console.log('Starting RTMS session...');
  console.log(`Meeting UUID: ${meeting_uuid}`);
  console.log(`Stream ID: ${rtms_stream_id}`);
  console.log(`Server URLs: ${server_urls}`);
  console.log(`Operator ID: ${operator_id || 'not provided'}`);

  // Check if already connected to this stream (true duplicate)
  // Note: We key by rtms_stream_id, not meeting_uuid, so failovers with new stream_ids work
  if (activeSessions.has(rtms_stream_id)) {
    console.log('Already connected to this stream, ignoring duplicate webhook');
    return;
  }

  // Check for existing session with same meeting_uuid but different stream_id (failover)
  // Clean up the old session before starting the new one
  for (const [existingStreamId, session] of activeSessions) {
    if (session.meetingUuid === meeting_uuid && existingStreamId !== rtms_stream_id) {
      console.log(`Failover detected: cleaning up old stream ${existingStreamId} for meeting ${meeting_uuid}`);
      try {
        session.client.leave();
      } catch (e) {
        console.warn('Error leaving old session during failover:', e.message);
      }
      activeSessions.delete(existingStreamId);
    }
  }

  try {
    // Create a new Client instance for this meeting (v1.0 class-based API)
    const client = new rtms.Client();

    // Set up transcript data handler BEFORE joining
    // v1.0 callback signature: (data, size, timestamp, metadata)
    // metadata: { userId, userName }
    client.onTranscriptData((data, size, timestamp, metadata) => {
      try {
        const text = data.toString('utf-8');
        // Only log PII (transcript text, user info) in debug mode
        const isDebug = process.env.LOG_LEVEL === 'debug' || process.env.ZM_RTMS_LOG_LEVEL === 'debug';
        if (isDebug) {
          console.log('Raw transcript event:');
          console.log(`  Text: ${text}`);
          console.log(`  Size: ${size}`);
          console.log(`  Timestamp: ${timestamp}`);
          console.log(`  Metadata:`, metadata);
        }

        // Mark first transcript received — boundary between initial roster and real joins
        const session = activeSessions.get(rtms_stream_id);
        if (session && !session.firstTranscriptReceived) {
          session.firstTranscriptReceived = true;
          console.log('First transcript received — subsequent joins are real joins');
        }

        // Record participant name from transcript for leave event lookup
        if (metadata?.userId && metadata?.userName) {
          if (session) session.participantNames.set(String(metadata.userId), metadata.userName);
        }

        const transcriptData = {
          text,
          timestamp, // Use real Zoom-provided timestamp
          userId: metadata?.userId,
          userName: metadata?.userName,
        };

        handleTranscript(meeting_uuid, transcriptData).catch(err => {
          console.error('Error handling transcript:', err);
        });
      } catch (err) {
        console.error('Error processing transcript buffer:', err);
      }
    });

    // Set up join confirmation handler
    client.onJoinConfirm((reason) => {
      console.log('Joined RTMS session, reason:', reason);
    });

    // Set up leave handler — v1.0 now receives a reason parameter
    client.onLeave((reason) => {
      console.log('RTMS Connection Closed, reason:', reason);
      activeSessions.delete(rtms_stream_id);
    });

    // Set up session update handler — v1.0 receives (event, session) object
    client.onSessionUpdate((event, session) => {
      console.log('Session update:', event, session);
    });

    // Handle media connection interruption (signaling survives, media only drops)
    // Note: This is different from meeting.rtms_interrupted webhook which is full signaling loss
    client.onMediaConnectionInterrupted((ts) => {
      console.warn(`Media connection interrupted at ${ts} for meeting ${meeting_uuid}`);
      // Notify backend so UI can show reconnecting state
      notifyBackend(meeting_uuid, 'media_interrupted').catch(err => {
        console.warn('Failed to notify backend of media interruption:', err.message);
      });
      // The SDK will automatically attempt to reconnect media
    });

    // Set up participant event handler — renamed from onUserUpdate in v1.0
    client.onParticipantEvent((event, timestamp, participants) => {
      console.log('Participant event:', event, timestamp, participants);

      const session = activeSessions.get(rtms_stream_id);

      // Suppress leave events fired during RTMS shutdown — SDK teardown artifacts
      if (session?.stopping && (event === 'leave' || event === 'user_leave')) {
        console.log('Suppressing leave events during RTMS shutdown');
        return;
      }

      const isJoin = event === 'join' || event === 'user_join';

      // Always record participant names from join events for later lookup
      if (isJoin && session) {
        (participants || []).forEach(p => {
          const pid = p.participantId ? String(p.participantId) : (p.userId ? String(p.userId) : null);
          const name = p.userName || p.name;
          if (pid && name) session.participantNames.set(pid, name);
        });
      }

      // Classify join events: before first transcript = initial roster, after = real join.
      // The RTMS SDK always reports existing participants as "join" before transcript data flows.
      const events = (participants || []).map(p => {
        const pid = p.participantId ? String(p.participantId) : (p.userId ? String(p.userId) : null);
        // Look up display name: prefer SDK-provided name, fall back to stored name
        const name = p.userName || p.name || session?.participantNames.get(pid) || `Participant ${pid || 'unknown'}`;

        let eventType;
        if (isJoin) {
          eventType = (session && !session.firstTranscriptReceived) ? 'initial_roster' : 'joined';
        } else if (event === 'leave' || event === 'user_leave') {
          eventType = 'left';
        } else {
          eventType = event;
        }

        return {
          eventType,
          participantName: name,
          participantId: pid,
          timestamp: Date.now(),
        };
      });

      if (events.length > 0) {
        broadcastParticipantEvents(meeting_uuid, events).catch(err => {
          console.error('Error forwarding participant events:', err);
        });
      }
    });

    // Store session info BEFORE joining to prevent duplicate handling
    // Keyed by rtms_stream_id for proper failover support
    activeSessions.set(rtms_stream_id, {
      client,
      meetingUuid: meeting_uuid, // Store meeting_uuid for lookups
      stopping: false,
      firstTranscriptReceived: false, // Set true on first transcript — used to classify initial roster vs real joins
      participantNames: new Map(), // userId → displayName lookup
      streamId: rtms_stream_id,
      startTime: new Date(),
      operatorId: operator_id || null,
      seqCounter: 0, // Atomic counter for transcript sequence numbers
    });

    // Join the RTMS session — v1.0 no longer uses pollInterval
    const result = client.join({
      meeting_uuid,
      rtms_stream_id,
      server_urls,
    });

    console.log('Join result:', result);

    // Notify backend that RTMS is active
    await notifyBackend(meeting_uuid, 'rtms_started', operator_id);

  } catch (error) {
    console.error('Failed to start RTMS:', error);
    console.error('Stack:', error.stack);
    activeSessions.delete(rtms_stream_id);
  }
}

/**
 * Helper: Find session by meeting_uuid (since rtms_stopped only provides meeting_uuid)
 */
function findSessionByMeetingUuid(meeting_uuid) {
  for (const [streamId, session] of activeSessions) {
    if (session.meetingUuid === meeting_uuid) {
      return { streamId, session };
    }
  }
  return null;
}

/**
 * Handle RTMS stopped event
 */
async function handleRTMSStopped(payload) {
  const { meeting_uuid, rtms_stream_id } = payload;

  console.log(`Stopping RTMS for meeting: ${meeting_uuid}`);

  // Try to find by rtms_stream_id first (if provided), then by meeting_uuid
  let session = rtms_stream_id ? activeSessions.get(rtms_stream_id) : null;
  let streamIdToDelete = rtms_stream_id;

  if (!session) {
    const found = findSessionByMeetingUuid(meeting_uuid);
    if (found) {
      session = found.session;
      streamIdToDelete = found.streamId;
    }
  }

  if (session) {
    try {
      // Set stopping flag to suppress false leave events during teardown
      session.stopping = true;
      session.client.leave();
      activeSessions.delete(streamIdToDelete);
      console.log('RTMS session stopped');
    } catch (error) {
      console.error('Error stopping RTMS:', error);
    }
  }

  // Notify backend (backend handles marking meeting as completed)
  await notifyBackend(meeting_uuid, 'rtms_stopped');
}

/**
 * Handle RTMS interrupted event (signaling connection lost)
 * The app should attempt to reconnect with exponential backoff.
 */
async function handleRTMSInterrupted(payload) {
  const { meeting_uuid, rtms_stream_id } = payload;

  console.log(`RTMS interrupted for meeting: ${meeting_uuid}, stream: ${rtms_stream_id}`);

  // Find and clean up the session
  let session = rtms_stream_id ? activeSessions.get(rtms_stream_id) : null;
  let streamIdToDelete = rtms_stream_id;

  if (!session) {
    const found = findSessionByMeetingUuid(meeting_uuid);
    if (found) {
      session = found.session;
      streamIdToDelete = found.streamId;
    }
  }

  if (session) {
    try {
      session.stopping = true;
      session.client.leave();
      activeSessions.delete(streamIdToDelete);
      console.log('Cleaned up interrupted RTMS session');
    } catch (error) {
      console.error('Error cleaning up interrupted session:', error);
    }
  }

  // Notify backend of interruption (so UI can show reconnecting state)
  await notifyBackend(meeting_uuid, 'rtms_interrupted');

  // Note: Zoom will send a new meeting.rtms_started webhook when reconnection is possible
  // The handleRTMSStarted function will create a new session with the new rtms_stream_id
}

/**
 * Handle individual transcript segment
 */
async function handleTranscript(meetingId, transcript) {
  const { text, timestamp, userId, userName } = transcript;

  // Find session by meeting_uuid (sessions are now keyed by rtms_stream_id)
  const found = findSessionByMeetingUuid(meetingId);
  const session = found?.session;
  const seqNo = session ? ++session.seqCounter : Date.now();

  // Use Zoom-provided timestamp if available, fallback to Date.now()
  const tStartMs = typeof timestamp === 'number' ? timestamp : Date.now();

  const segment = {
    speakerId: userId ? String(userId) : 'unknown',
    speakerLabel: userName || (userId ? `Speaker ${userId}` : 'Speaker'),
    text: text || '',
    tStartMs: tStartMs,
    tEndMs: tStartMs,
    seqNo: seqNo,
  };

  await broadcastSegment(meetingId, segment);
  // Only log transcript content in debug mode to avoid PII exposure
  const isDebug = process.env.LOG_LEVEL === 'debug' || process.env.ZM_RTMS_LOG_LEVEL === 'debug';
  if (isDebug) {
    console.log(`Broadcast segment: "${(text || '').substring(0, 50)}..."`);
  }
}

/**
 * Broadcast segment to WebSocket clients via backend
 */
async function broadcastSegment(meetingId, segment) {
  try {
    // Use Docker service name for inter-container communication
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    await axios.post(`${backendUrl}/api/rtms/broadcast`, {
      meetingId,
      segment,
    });
    console.log('Sent to backend for broadcast');
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
    await axios.post(`${backendUrl}/api/rtms/participant-event`, {
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
async function notifyBackend(meetingId, status, operatorId) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    await axios.post(`${backendUrl}/api/rtms/status`, {
      meetingId,
      status,
      ...(operatorId && { operatorId }),
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
    activeSessions: activeSessions.size,
    sessions: Array.from(activeSessions.keys()),
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const PORT = process.env.RTMS_PORT || 3002;

app.listen(PORT, () => {
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
  for (const [meetingId, session] of activeSessions) {
    try {
      session.stopping = true;
      session.client.leave();
      console.log(`Closed RTMS session for meeting: ${meetingId}`);
    } catch (err) {
      console.error(`Error closing session ${meetingId}:`, err.message);
    }
  }
  activeSessions.clear();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
