require('dotenv').config({ path: '../../.env' });
const express = require('express');
const crypto = require('crypto');
const rtmsModule = require('@zoom/rtms');
const rtms = rtmsModule.default; // ES module default export
const axios = require('axios');
const realtimeBus = require('./realtimeBus');
const controlStore = require('./controlStore');
const workerLauncher = require('./workerLauncher');

// Logging is now configured via ZM_RTMS_LOG_LEVEL env var (e.g. "debug")

const app = express();
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const IS_WORKER_MODE = process.env.RTMS_WORKER_MODE === 'single-stream';
const workerKeepAlive = IS_WORKER_MODE ? setInterval(() => {}, 60 * 60 * 1000) : null;

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySignature(req, secret, timestampHeader, signatureHeader) {
  if (!secret) {
    return false;
  }

  const signature = req.headers[signatureHeader];
  const timestamp = req.headers[timestampHeader];
  if (!signature || !timestamp) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const message = `v0:${timestamp}:${rawBody}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return timingSafeEqual(signature, expectedSignature);
}

function verifyZoomWebhookSignature(req) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || process.env.RTMS_WEBHOOK_SECRET;
  return verifySignature(req, secret, 'x-zm-request-timestamp', 'x-zm-signature');
}

function verifyInternalWebhookSignature(req) {
  return verifySignature(req, process.env.INTERNAL_WEBHOOK_SECRET, 'x-arlo-request-timestamp', 'x-arlo-signature');
}

function buildInternalRequestHeaders(body) {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET;
  if (!secret) return {};

  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  return {
    'x-arlo-internal': 'true',
    'x-arlo-request-timestamp': timestamp,
    'x-arlo-signature': 'v0=' + crypto
      .createHmac('sha256', secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex'),
  };
}

function unwrapPayload(payload = {}) {
  return payload.object ? { ...payload, ...payload.object } : payload;
}

// Middleware
app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = buffer;
  },
}));

// Store active RTMS sessions — each meeting gets its own Client instance
const activeSessions = new Map();

// =============================================================================
// RTMS WEBHOOK HANDLER
// =============================================================================

/**
 * POST /webhook
 * Receive RTMS webhooks from Zoom
 */
app.post('/webhook', async (req, res) => {
  const { event, payload } = req.body;

  if (event === 'endpoint.url_validation') {
    const plainToken = payload?.plainToken;
    const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || process.env.RTMS_WEBHOOK_SECRET;
    if (!plainToken || !webhookSecret) {
      return res.status(400).json({ error: 'invalid_url_validation_request' });
    }

    return res.json({
      plainToken,
      encryptedToken: crypto.createHmac('sha256', webhookSecret).update(plainToken).digest('hex'),
    });
  }

  const isInternal = req.headers['x-arlo-internal'] === 'true';
  const signatureIsValid = isInternal
    ? verifyInternalWebhookSignature(req)
    : verifyZoomWebhookSignature(req);
  if (!signatureIsValid) {
    console.error(`Webhook signature verification failed source=${isInternal ? 'internal' : 'zoom'}`);
    return res.status(401).send('Unauthorized');
  }

  console.log(`RTMS Webhook Received: ${event}`);

  // Acknowledge webhook immediately
  res.status(200).send('OK');

  try {
    switch (event) {
      case 'meeting.rtms_started':
        if (!IS_WORKER_MODE && workerLauncher.enabled()) {
          await dispatchRTMSStarted(payload);
        } else {
          await handleRTMSStarted(payload);
        }
        break;

      case 'meeting.rtms_stopped':
        if (!IS_WORKER_MODE && workerLauncher.enabled()) {
          await dispatchRTMSStopped(payload);
        } else {
          await handleRTMSStopped(payload);
        }
        break;

      default:
        console.log(`Unhandled webhook event: ${event}`);
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
  }
});

/**
 * Dispatch RTMS start to a one-meeting ECS worker task.
 */
async function dispatchRTMSStarted(payload) {
  const {
    meeting_uuid,
    rtms_stream_id,
    server_urls,
    operator_id
  } = unwrapPayload(payload);

  console.log('Dispatching RTMS session to worker...');
  console.log(`Meeting UUID: ${meeting_uuid}`);
  console.log(`Stream ID: ${rtms_stream_id}`);
  console.log(`Operator ID: ${operator_id || 'not provided'}`);

  if (!meeting_uuid || !rtms_stream_id || !server_urls) {
    throw new Error('RTMS start payload is missing meeting_uuid, rtms_stream_id, or server_urls');
  }
  if (!controlStore.enabled()) {
    throw new Error('RTMS control store is not configured');
  }

  const existing = await controlStore.getActiveSession(meeting_uuid);
  if (
    existing?.rtmsStreamId === rtms_stream_id &&
    ['launching', 'running'].includes(existing.status)
  ) {
    console.log(`Worker already active for meeting ${meeting_uuid}, task ${existing.taskArn || 'pending'}`);
    return;
  }

  if (
    existing?.taskArn &&
    existing.rtmsStreamId &&
    existing.rtmsStreamId !== rtms_stream_id
  ) {
    console.warn(`Stopping stale worker ${existing.taskArn} for previous stream ${existing.rtmsStreamId}`);
    await workerLauncher.stopWorker(existing.taskArn, 'Superseded by a newer RTMS stream').catch((err) => {
      console.warn('Failed to stop stale RTMS worker:', err.message);
    });
    await realtimeBus.deleteMeeting(meeting_uuid, existing.rtmsStreamId).catch((err) => {
      console.warn('Failed to delete stale Valkey RTMS session:', err.message);
    });
    await controlStore.deleteSession(meeting_uuid, existing.rtmsStreamId).catch((err) => {
      console.warn('Failed to remove stale RTMS control session:', err.message);
    });
  }

  try {
    await controlStore.putStartEvent({
      meetingId: meeting_uuid,
      rtmsStreamId: rtms_stream_id,
      payload: unwrapPayload(payload),
      operatorId: operator_id || null,
    });
  } catch (error) {
    throw error;
  }
  await realtimeBus.recordRtmsSession({
    meetingId: meeting_uuid,
    rtmsMeetingId: meeting_uuid,
    rtmsStreamId: rtms_stream_id,
    zoomUserId: operator_id || null,
    operatorId: operator_id || null,
    status: 'launching',
  }).catch((err) => {
    console.warn('Failed to record launching RTMS session in Valkey:', err.message);
  });

  try {
    const taskArn = await workerLauncher.runWorker({
      meetingId: meeting_uuid,
      rtmsStreamId: rtms_stream_id,
    });
    await controlStore.markTaskStarted(meeting_uuid, rtms_stream_id, taskArn);
    console.log(`Launched RTMS worker task: ${taskArn}`);
  } catch (error) {
    await controlStore.markLaunchFailed(meeting_uuid, rtms_stream_id, error.message).catch(() => {});
    await realtimeBus.deleteMeeting(meeting_uuid, rtms_stream_id).catch(() => {});
    throw error;
  }
}

/**
 * Stop the one-meeting ECS worker task for an RTMS stop event.
 */
async function dispatchRTMSStopped(payload) {
  const { meeting_uuid } = unwrapPayload(payload);

  console.log(`Dispatching RTMS stop for meeting: ${meeting_uuid}`);
  if (!meeting_uuid) {
    throw new Error('RTMS stop payload is missing meeting_uuid');
  }

  const session = controlStore.enabled()
    ? await controlStore.getActiveSession(meeting_uuid)
    : null;

  if (session?.taskArn) {
    await workerLauncher.stopWorker(session.taskArn, 'RTMS meeting stopped').catch((error) => {
      console.warn('Failed to stop RTMS worker:', error.message);
    });
    console.log(`Stopped RTMS worker task: ${session.taskArn}`);
  } else {
    console.log('No active RTMS worker task found for stop event');
  }

  await notifyBackend(meeting_uuid, 'rtms_stopped', session?.operatorId, session?.rtmsStreamId);
  await realtimeBus.deleteMeeting(meeting_uuid, session?.rtmsStreamId).catch((err) => {
    console.warn('Failed to delete Valkey RTMS session:', err.message);
  });
  if (controlStore.enabled()) {
    await controlStore.deleteSession(meeting_uuid, session?.rtmsStreamId).catch((err) => {
      console.warn('Failed to delete RTMS control session:', err.message);
    });
  }
}

/**
 * Handle RTMS started event — creates a new Client per meeting
 */
async function handleRTMSStarted(payload) {
  const {
    meeting_uuid,
    rtms_stream_id,
    server_urls,
    operator_id
  } = unwrapPayload(payload);

  console.log('Starting RTMS session...');
  console.log(`Meeting UUID: ${meeting_uuid}`);
  console.log(`Stream ID: ${rtms_stream_id}`);
  console.log(`Operator ID: ${operator_id || 'not provided'}`);

  if (!meeting_uuid || !rtms_stream_id || !server_urls) {
    throw new Error('RTMS start payload is missing meeting_uuid, rtms_stream_id, or server_urls');
  }

  const rtmsClientId = process.env.ZM_RTMS_CLIENT || process.env.ZOOM_CLIENT_ID;
  const rtmsClientSecret = process.env.ZM_RTMS_SECRET || process.env.ZOOM_CLIENT_SECRET;
  if (!rtmsClientId || !rtmsClientSecret) {
    throw new Error('RTMS signaling credentials are not configured');
  }

  // Check if already connected to this meeting (prevent duplicate webhook handling)
  if (activeSessions.has(meeting_uuid)) {
    console.log('Already connected to this meeting, ignoring duplicate webhook');
    return;
  }

  try {
    // Create a new Client instance for this meeting (v1.0 class-based API)
    const client = new rtms.Client();

    // Set up transcript data handler BEFORE joining
    // v1.0 callback signature: (data, timestamp, metadata, user)
    // user: { userId, userName }
    client.onTranscriptData((data, timestamp, metadata, user) => {
      try {
        const text = data.toString('utf-8');
        console.log(`Transcript event received: timestamp=${timestamp} bytes=${Buffer.byteLength(text, 'utf8')} speaker=${user?.userId || 'unknown'}`);

        // Mark first transcript received — boundary between initial roster and real joins
        const session = activeSessions.get(meeting_uuid);
        if (session && !session.firstTranscriptReceived) {
          session.firstTranscriptReceived = true;
          console.log('First transcript received — subsequent joins are real joins');
        }

        // Record participant name from transcript for leave event lookup
        if (user?.userId && user?.userName) {
          if (session) session.participantNames.set(String(user.userId), user.userName);
        }

        const transcriptData = {
          text,
          timestamp,
          userId: user?.userId,
          userName: user?.userName,
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
      const session = activeSessions.get(meeting_uuid);
      activeSessions.delete(meeting_uuid);
      if (IS_WORKER_MODE) {
        Promise.resolve()
          .then(() => notifyBackend(meeting_uuid, 'rtms_stopped', session?.operatorId, session?.streamId))
          .then(() => realtimeBus.deleteMeeting(meeting_uuid, session?.streamId))
          .then(() => controlStore.markWorkerCompleted(meeting_uuid, session?.streamId, reason))
          .catch((error) => {
            console.warn('Worker cleanup after RTMS leave failed:', error.message);
          })
          .finally(() => {
            if (workerKeepAlive) clearInterval(workerKeepAlive);
            setTimeout(() => process.exit(0), 100);
          });
      }
    });

    // Set up session update handler — v1.0 receives (event, session) object
    client.onSessionUpdate((event, session) => {
      console.log('Session update:', event, session);
    });

    // Set up participant event handler — renamed from onUserUpdate in v1.0
    client.onParticipantEvent((event, timestamp, participants) => {
      console.log('Participant event:', event, timestamp, participants);

      const session = activeSessions.get(meeting_uuid);

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
    activeSessions.set(meeting_uuid, {
      client,
      stopping: false,
      firstTranscriptReceived: false, // Set true on first transcript — used to classify initial roster vs real joins
      participantNames: new Map(), // userId → displayName lookup
      streamId: rtms_stream_id,
      startTime: new Date(),
      operatorId: operator_id || null,
      seqCounter: 0, // Atomic counter for transcript sequence numbers
    });
    await realtimeBus.recordRtmsSession({
      meetingId: meeting_uuid,
      rtmsMeetingId: meeting_uuid,
      rtmsStreamId: rtms_stream_id,
      zoomUserId: operator_id || null,
    operatorId: operator_id || null,
    realtimeKeyPrefix: process.env.REALTIME_KEY_PREFIX || null,
    realtimeChannelPrefix: process.env.REALTIME_CHANNEL_PREFIX || null,
    status: 'rtms_started',
  }).catch((err) => {
      console.warn('Failed to record RTMS session in Valkey:', err.message);
    });

    // Join the RTMS session — v1.0 no longer uses pollInterval
    const result = client.join({
      meeting_uuid,
      rtms_stream_id,
      server_urls,
      client: rtmsClientId,
      secret: rtmsClientSecret,
    });

    console.log('Join result:', result);
    if (!result) {
      throw new Error('RTMS SDK rejected the signaling join request');
    }

    // Notify backend that RTMS is active
    await notifyBackend(meeting_uuid, 'rtms_started', operator_id, rtms_stream_id);

  } catch (error) {
    console.error('Failed to start RTMS:', error);
    console.error('Stack:', error.stack);
    activeSessions.delete(meeting_uuid);
    if (IS_WORKER_MODE) {
      await controlStore.markLaunchFailed(meeting_uuid, rtms_stream_id, error.message).catch(() => {});
      throw error;
    }
  }
}

/**
 * Handle RTMS stopped event
 */
async function handleRTMSStopped(payload) {
  const { meeting_uuid } = unwrapPayload(payload);

  console.log(`Stopping RTMS for meeting: ${meeting_uuid}`);

  const session = activeSessions.get(meeting_uuid);
  if (session) {
    try {
      // Set stopping flag to suppress false leave events during teardown
      session.stopping = true;
      session.client.leave();
      activeSessions.delete(meeting_uuid);
      console.log('RTMS session stopped');
    } catch (error) {
      console.error('Error stopping RTMS:', error);
    }
  }

  // Notify backend (backend handles marking meeting as completed)
  await notifyBackend(meeting_uuid, 'rtms_stopped', session?.operatorId, session?.streamId);
  await realtimeBus.deleteMeeting(meeting_uuid, session?.streamId).catch((err) => {
    console.warn('Failed to delete Valkey RTMS session:', err.message);
  });
}

/**
 * Handle individual transcript segment
 */
async function handleTranscript(meetingId, transcript) {
  const { text, timestamp, userId, userName } = transcript;

  const session = activeSessions.get(meetingId);
  const seqNo = session ? ++session.seqCounter : Date.now();
  const now = Date.now();

  const segment = {
    speakerId: userId ? String(userId) : 'unknown',
    speakerLabel: userName || (userId ? `Speaker ${userId}` : 'Speaker'),
    text: text || '',
    tStartMs: now,
    tEndMs: now,
    seqNo: seqNo,
  };

  await broadcastSegment(meetingId, segment);
  console.log(`Broadcast transcript segment: seq=${seqNo} bytes=${Buffer.byteLength(text || '', 'utf8')}`);
}

/**
 * Broadcast segment to WebSocket clients via backend
 */
async function broadcastSegment(meetingId, segment) {
  const session = activeSessions.get(meetingId);
  const metadata = {
    meetingId,
    rtmsMeetingId: meetingId,
    rtmsStreamId: session?.streamId || null,
    zoomUserId: session?.operatorId || null,
    operatorId: session?.operatorId || null,
  };
  const published = await realtimeBus.publishTranscriptSegment(meetingId, segment, metadata)
    .catch((error) => {
      console.warn('Failed to publish segment to Valkey:', error.message);
      return false;
    });

  try {
    // Use Docker service name for inter-container communication
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    const body = {
      meetingId,
      segment,
      publish: !published,
      metadata,
    };
    await axios.post(`${backendUrl}/api/rtms/broadcast`, body, {
      headers: buildInternalRequestHeaders(body),
    });
    console.log(published ? 'Published segment to Valkey and sent to backend for persistence' : 'Sent to backend for broadcast');
  } catch (error) {
    // Non-critical, just log
    console.warn('Failed to broadcast segment:', error.message);
  }
}

/**
 * Broadcast participant events to frontend via backend
 */
async function broadcastParticipantEvents(meetingId, events) {
  const session = activeSessions.get(meetingId);
  const metadata = {
    meetingId,
    rtmsMeetingId: meetingId,
    rtmsStreamId: session?.streamId || null,
    zoomUserId: session?.operatorId || null,
    operatorId: session?.operatorId || null,
  };
  let allPublished = true;
  for (const event of events) {
    const published = await realtimeBus.publishParticipantEvent(meetingId, event, metadata)
      .catch((error) => {
        console.warn('Failed to publish participant event to Valkey:', error.message);
        return false;
      });
    allPublished = allPublished && published;
  }

  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    const body = {
      meetingId,
      events,
      publish: !allPublished,
      metadata,
    };
    await axios.post(`${backendUrl}/api/rtms/participant-event`, body, {
      headers: buildInternalRequestHeaders(body),
    });
    console.log(`Sent ${events.length} participant events to backend for broadcast`);
  } catch (error) {
    console.warn('Failed to broadcast participant events:', error.message);
  }
}

/**
 * Notify backend of RTMS status change
 */
async function notifyBackend(meetingId, status, operatorId, rtmsStreamId) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';
    const body = {
      meetingId,
      status,
      ...(operatorId && { operatorId }),
      ...(rtmsStreamId && { rtmsStreamId }),
    };
    await axios.post(`${backendUrl}/api/rtms/status`, body, {
      headers: buildInternalRequestHeaders(body),
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

async function runSingleStreamWorker() {
  const meetingId = process.env.RTMS_WORKER_MEETING_ID;
  const rtmsStreamId = process.env.RTMS_WORKER_STREAM_ID;

  if (!meetingId || !rtmsStreamId) {
    throw new Error('RTMS worker requires RTMS_WORKER_MEETING_ID and RTMS_WORKER_STREAM_ID');
  }
  if (!controlStore.enabled()) {
    throw new Error('RTMS worker requires DYNAMODB_TABLE_NAME');
  }

  const session = await controlStore.getSession(meetingId, rtmsStreamId);
  if (!session?.payload) {
    throw new Error(`No RTMS start payload found for meeting ${meetingId} stream ${rtmsStreamId}`);
  }

  console.log('='.repeat(60));
  console.log('Arlo Meeting Assistant RTMS Worker');
  console.log('='.repeat(60));
  console.log(`Meeting UUID: ${meetingId}`);
  console.log(`Stream ID: ${rtmsStreamId}`);
  console.log('='.repeat(60));

  await handleRTMSStarted(session.payload);
}

function startControlServer() {
  app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('Arlo Meeting Assistant RTMS Control Service');
    console.log('='.repeat(60));
    console.log(`Port: ${PORT}`);
    console.log(`Webhook: http://localhost:${PORT}/webhook`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log('='.repeat(60));
    console.log(workerLauncher.enabled()
      ? 'Dispatching RTMS starts to per-meeting ECS workers...'
      : 'Worker launcher disabled; handling RTMS streams inline...');
    console.log('='.repeat(60));
  });
}

if (IS_WORKER_MODE) {
  runSingleStreamWorker().catch((error) => {
    console.error('RTMS worker failed:', error);
    if (workerKeepAlive) clearInterval(workerKeepAlive);
    process.exit(1);
  });
} else {
  startControlServer();
}

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
