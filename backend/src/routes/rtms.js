const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();
const config = require('../config');
const logger = require('../lib/logger');
const { broadcastTranscriptSegment, broadcastParticipantEvent, broadcastMeetingStatus, crossRegisterUser, getStats } = require('../services/websocket');
const { zoomGet } = require('../services/zoomApi');
const prisma = require('../lib/prisma');

// Check if meeting persistence is disabled (demo mode)
const PERSISTENCE_DISABLED = config.disableMeetingPersistence;
if (PERSISTENCE_DISABLED) {
  console.log('⚠️ Meeting persistence DISABLED — transcripts will not be saved to database');
}

/**
 * Send a response and log it in debug mode
 * Ensures logged status always matches actual response
 */
function sendResponse(res, statusCode, body) {
  logger.debug('📤 Response:', JSON.stringify({ status: statusCode, body }));
  if (typeof body === 'string') {
    return res.status(statusCode).send(body);
  }
  return res.status(statusCode).json(body);
}

// Cache for meeting IDs -> database meeting records
const meetingCache = new Map();

/**
 * Verify Zoom webhook HMAC signature
 * @param {Buffer} rawBody - Raw request body bytes
 * @param {string} timestamp - x-zm-request-timestamp header
 * @param {string} signature - x-zm-signature header
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(rawBody, timestamp, signature) {
  const secret = config.zoomClientSecret;

  if (!secret) {
    console.warn('⚠️ No webhook secret configured — skipping HMAC verification (dev mode)');
    return true;
  }

  if (!signature || !timestamp) {
    console.warn('⚠️ Missing signature or timestamp headers');
    return false;
  }

  // Reject if timestamp is more than 5 minutes old (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const reqTimestamp = parseInt(timestamp, 10);
  if (isNaN(reqTimestamp) || Math.abs(now - reqTimestamp) > 300) {
    console.warn('⚠️ Webhook timestamp too old or invalid — possible replay attack');
    return false;
  }

  // Compute expected signature: v0=HMAC-SHA256("v0:" + timestamp + ":" + rawBody)
  const message = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', secret)
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

/**
 * POST /api/rtms/webhook
 * Receive RTMS webhooks from Zoom
 *
 * Note: This route needs raw body access for HMAC verification.
 * The raw body is captured via express.raw() middleware before JSON parsing.
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Handle both Buffer (from express.raw) and pre-parsed object (from express.json)
  let body;
  let rawBodyStr;

  if (Buffer.isBuffer(req.body)) {
    // Body is a Buffer from express.raw()
    rawBodyStr = req.body.toString('utf8');
    try {
      body = JSON.parse(rawBodyStr);
    } catch (e) {
      logger.error('❌ Invalid JSON in webhook request');
      logger.error('❌ Parse error:', e.message);
      logger.error('❌ Raw body:', rawBodyStr);
      return sendResponse(res, 400, { error: 'Invalid JSON' });
    }
  } else if (req.body && typeof req.body === 'object') {
    // Body was already parsed by express.json() middleware
    body = req.body;
    rawBodyStr = JSON.stringify(body);
  } else {
    logger.error('❌ Empty or invalid webhook request body');
    logger.error('❌ Body type:', typeof req.body);
    logger.error('❌ Body value:', String(req.body));
    return sendResponse(res, 400, { error: 'Invalid request body' });
  }

  // Debug: log request details
  logger.debug('📨 Webhook request:', JSON.stringify({
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    bodyType: Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body,
    body: body,
  }, null, 2));

  const { event, payload } = body;

  // Handle Zoom webhook validation (endpoint URL validation) — no signature on these
  if (event === 'endpoint.url_validation') {
    const { plainToken } = payload;
    logger.info('📨 Webhook validation request received');

    // Hash the plainToken with client secret
    const hash = crypto
      .createHmac('sha256', config.zoomClientSecret)
      .update(plainToken)
      .digest('hex');

    logger.info('✅ Webhook validation response sent');
    return sendResponse(res, 200, { plainToken, encryptedToken: hash });
  }

  // Verify HMAC signature for all other events
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];

  // Use Buffer for signature verification (convert back if body was pre-parsed)
  const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(rawBodyStr, 'utf8');
  if (!verifyWebhookSignature(rawBodyBuffer, timestamp, signature)) {
    logger.error('❌ Webhook signature verification failed');
    return sendResponse(res, 401, { error: 'Unauthorized' });
  }

  console.log(`📨 RTMS Webhook: ${event} (signature verified)`);
  if (payload?.operator_id) {
    console.log(`📨 Operator ID: ${payload.operator_id}`);
  }
  if (config.logLevel === 'debug') {
    console.log(`📨 Payload:`, JSON.stringify(payload, null, 2));
  }

  // Forward webhook to RTMS service (internal network only)
  if (event === 'meeting.rtms_started' || event === 'meeting.rtms_stopped') {
    try {
      const rtmsServiceUrl = process.env.RTMS_SERVICE_URL || 'http://rtms:3002';
      await axios.post(`${rtmsServiceUrl}/webhook`, body, {
        timeout: 5000,
        headers: {
          // Forward original Zoom signature headers — RTMS service will re-verify
          'x-zm-signature': signature,
          'x-zm-request-timestamp': timestamp,
        },
      });
      console.log(`✅ Forwarded ${event} to RTMS service`);
    } catch (error) {
      console.error(`❌ Failed to forward webhook to RTMS service:`, error.message);
      // Don't fail the webhook - Zoom expects 200 response
    }
  }

  // Acknowledge webhook immediately
  sendResponse(res, 200, 'OK');
});

/**
 * POST /api/rtms/status
 * Receive RTMS status updates from RTMS service
 */
router.post('/status', async (req, res) => {
  const { meetingId, status, meetingTopic, operatorId } = req.body;

  console.log(`📡 RTMS Status Update: ${status} for meeting ${meetingId}`);
  console.log(`📡 Operator ID: ${operatorId || 'not provided'}`);

  // Track dbMeetingId across all processing steps
  let dbMeetingId = null;

  try {
    if (PERSISTENCE_DISABLED) {
      // Persistence disabled — skip all DB writes but still do cross-registration
      console.log('💾 Persistence disabled — skipping meeting DB operations');

      if (status === 'rtms_started' && operatorId) {
        // Still need to find user for cross-registration
        const owner = await prisma.user.findUnique({
          where: { zoomUserId: operatorId },
        });
        if (owner) {
          crossRegisterUser(owner.id, meetingId);
          console.log(`✅ Cross-registered user ${owner.displayName} for meeting ${meetingId}`);
        }
      }
    } else if (status === 'rtms_started') {
      // Resolve operator to a real user if possible
      let owner = null;
      if (operatorId) {
        owner = await prisma.user.findUnique({
          where: { zoomUserId: operatorId },
        });
        if (owner) {
          console.log(`✅ Matched operator ${operatorId} to user ${owner.displayName}`);
        } else {
          console.log(`⚠️ No user found for operator ${operatorId}, falling back to system user`);
        }
      }

      // Fall back to system user
      if (!owner) {
        owner = await prisma.user.upsert({
          where: { zoomUserId: 'system' },
          update: {},
          create: {
            zoomUserId: 'system',
            email: 'system@arlo-meeting-assistant.local',
            displayName: 'System',
          },
        });
      }

      // Find existing meeting by UUID (unique per instance).
      // Reuse it if found (reopen if completed), only create if none exists.
      let dbMeeting = await prisma.meeting.findUnique({
        where: { zoomMeetingId: meetingId },
      });

      if (dbMeeting) {
        // Reopen completed meetings (same RTMS session, app was closed/reopened)
        if (dbMeeting.status === 'completed') {
          dbMeeting = await prisma.meeting.update({
            where: { id: dbMeeting.id },
            data: { status: 'ongoing', endTime: null },
          });
          console.log(`✅ Reopened completed meeting: ${dbMeeting.id}`);
        }

        // If meeting exists under system user but we now have a real owner, reassign
        if (owner.zoomUserId !== 'system' && dbMeeting.ownerId !== owner.id) {
          const currentOwner = await prisma.user.findUnique({ where: { id: dbMeeting.ownerId } });
          if (currentOwner?.zoomUserId === 'system') {
            dbMeeting = await prisma.meeting.update({
              where: { id: dbMeeting.id },
              data: { ownerId: owner.id },
            });
            console.log(`✅ Reassigned meeting from system user to ${owner.displayName}`);
          }
        }
      } else {
        dbMeeting = await prisma.meeting.create({
          data: {
            zoomMeetingId: meetingId,
            title: meetingTopic || `Meeting ${new Date().toLocaleDateString()}`,
            startTime: new Date(),
            status: 'ongoing',
            ownerId: owner.id,
          },
        });
        console.log(`✅ Created meeting record: ${dbMeeting.id} (owner: ${owner.displayName})`);
      }

      // Cache the meeting ID mapping
      meetingCache.set(meetingId, dbMeeting.id);
      dbMeetingId = dbMeeting.id;

      // Cross-register any existing WS connections for this user under the RTMS UUID.
      // The frontend's WS is subscribed under the SDK UUID (which differs from the
      // RTMS UUID), so we need to ensure transcript broadcasts reach the client.
      crossRegisterUser(owner.id, meetingId);

      // Enrich meeting metadata from Zoom API (non-blocking)
      if (owner.zoomUserId !== 'system') {
        enrichMeetingFromZoom(dbMeeting.id, meetingId, owner.id).catch(err => {
          console.warn('⚠️ Meeting enrichment failed (non-fatal):', err.message);
        });
      }

    } else if (status === 'rtms_stopped') {
      // Mark meeting as completed
      dbMeetingId = meetingCache.get(meetingId);

      // Fall back to DB lookup if cache misses
      if (!dbMeetingId) {
        const m = await prisma.meeting.findUnique({
          where: { zoomMeetingId: meetingId },
        });
        if (m) dbMeetingId = m.id;
      }

      if (dbMeetingId) {
        await prisma.meeting.update({
          where: { id: dbMeetingId },
          data: {
            status: 'completed',
            endTime: new Date(),
          },
        });
        console.log(`✅ Marked meeting ${dbMeetingId} as completed`);
        // Don't delete from cache yet — lifecycle event save below still needs it
      }
    }
  } catch (error) {
    console.error('❌ Database error in status update:', error.message);
    console.error('❌ Full error:', error);
    // Don't fail the request - we still want to broadcast
  }

  // Broadcast status change to WebSocket clients
  const sentCount = broadcastMeetingStatus(meetingId, status);
  console.log(`📡 Broadcast status to ${sentCount} clients`);

  // Also broadcast a transcription lifecycle event for the timeline
  const lifecycleMap = {
    rtms_started: 'transcription_started',
    rtms_stopped: 'transcription_stopped',
    rtms_paused: 'transcription_paused',
    rtms_resumed: 'transcription_resumed',
  };
  const eventType = lifecycleMap[status];
  if (eventType) {
    const lifecycleEvent = {
      eventType,
      participantName: 'Arlo',
      participantId: null,
      timestamp: Date.now(),
    };
    broadcastParticipantEvent(meetingId, lifecycleEvent);

    // Save to database using local dbMeetingId (not cache, which may be deleted)
    // Skip when persistence is disabled
    if (dbMeetingId && !PERSISTENCE_DISABLED) {
      prisma.participantEvent.create({
        data: {
          meetingId: dbMeetingId,
          eventType,
          participantName: 'Arlo',
          participantId: null,
          timestamp: BigInt(lifecycleEvent.timestamp),
        },
      }).catch(err => {
        console.error('❌ Failed to save lifecycle event:', err.message);
      });
    }
  }

  // Clean up cache after all processing is complete
  if (status === 'rtms_stopped') {
    meetingCache.delete(meetingId);
  }

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/broadcast
 * Receive transcript segments from RTMS service to broadcast to clients
 */
router.post('/broadcast', async (req, res) => {
  const { meetingId, segment } = req.body;
  const stats = getStats();

  console.log(`📝 Transcript segment for meeting ${meetingId}:`, segment?.text?.substring(0, 50));

  // Broadcast transcript segment to all WebSocket clients immediately
  const sentCount = broadcastTranscriptSegment(meetingId, segment);
  console.log(`📡 Broadcast transcript to ${sentCount} clients`);

  // Save to database in the background (don't block the response)
  console.log('💾 Starting background save of transcript segment...');
  saveTranscriptSegment(meetingId, segment).catch(err => {
    console.error('❌ Failed to save transcript segment:', err.message);
    console.error('❌ Full error:', err);
  });

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * Save transcript segment to database
 */
async function saveTranscriptSegment(zoomMeetingId, segment) {
  // Skip DB writes when persistence is disabled
  if (PERSISTENCE_DISABLED) {
    console.log('💾 Persistence disabled — skipping transcript save');
    return;
  }

  // Get the database meeting ID from cache
  let dbMeetingId = meetingCache.get(zoomMeetingId);

  // If not in cache, look up the unique meeting by UUID
  if (!dbMeetingId) {
    const dbMeeting = await prisma.meeting.findUnique({
      where: { zoomMeetingId: zoomMeetingId },
    });
    if (dbMeeting) {
      dbMeetingId = dbMeeting.id;
      meetingCache.set(zoomMeetingId, dbMeetingId);
    } else {
      console.log('⚠️ No meeting record found for segment, skipping save');
      return;
    }
  }

  // Find or create speaker
  let speaker = null;
  if (segment.speakerId && segment.speakerId !== 'unknown') {
    speaker = await prisma.speaker.upsert({
      where: {
        meetingId_zoomParticipantId: {
          meetingId: dbMeetingId,
          zoomParticipantId: segment.speakerId,
        },
      },
      create: {
        meetingId: dbMeetingId,
        label: segment.speakerLabel || 'Speaker',
        zoomParticipantId: segment.speakerId,
        displayName: segment.speakerLabel,
      },
      update: {
        // Update display name if changed
        displayName: segment.speakerLabel || undefined,
      },
    });
  }

  // RTMS service sends timestamps in milliseconds (Date.now())
  const tStartMs = segment.tStartMs || 0;
  const tEndMs = segment.tEndMs || tStartMs;

  // Save transcript segment (upsert to handle duplicates)
  await prisma.transcriptSegment.upsert({
    where: {
      meetingId_seqNo: {
        meetingId: dbMeetingId,
        seqNo: BigInt(segment.seqNo || Date.now()),
      },
    },
    create: {
      meetingId: dbMeetingId,
      speakerId: speaker?.id,
      tStartMs: tStartMs,
      tEndMs: tEndMs,
      seqNo: BigInt(segment.seqNo || Date.now()),
      text: segment.text || '',
      confidence: segment.confidence,
    },
    update: {
      text: segment.text || '',
      tEndMs: tEndMs,
    },
  });

  console.log(`💾 Saved transcript segment to database (${tStartMs}ms - ${tEndMs}ms)`);
}

/**
 * POST /api/rtms/participant-event
 * Receive participant join/leave events from RTMS service
 */
router.post('/participant-event', async (req, res) => {
  const { meetingId, events } = req.body;

  console.log(`👥 Participant event for meeting ${meetingId}:`, events);

  // Broadcast each event to WebSocket clients immediately
  let sentCount = 0;
  for (const event of events) {
    sentCount += broadcastParticipantEvent(meetingId, event);
  }

  // Save to database in the background
  saveParticipantEvents(meetingId, events).catch(err => {
    console.error('❌ Failed to save participant events:', err.message);
  });

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * Save participant events to database
 */
async function saveParticipantEvents(zoomMeetingId, events) {
  // Skip DB writes when persistence is disabled
  if (PERSISTENCE_DISABLED) {
    console.log('💾 Persistence disabled — skipping participant events save');
    return;
  }

  let dbMeetingId = meetingCache.get(zoomMeetingId);

  if (!dbMeetingId) {
    const dbMeeting = await prisma.meeting.findUnique({
      where: { zoomMeetingId: zoomMeetingId },
    });
    if (dbMeeting) {
      dbMeetingId = dbMeeting.id;
      meetingCache.set(zoomMeetingId, dbMeetingId);
    } else {
      console.log('⚠️ No meeting record found for participant events, skipping save');
      return;
    }
  }

  for (const event of events) {
    await prisma.participantEvent.create({
      data: {
        meetingId: dbMeetingId,
        eventType: event.eventType,
        participantName: event.participantName,
        participantId: event.participantId || null,
        timestamp: BigInt(event.timestamp),
      },
    });
  }

  console.log(`💾 Saved ${events.length} participant events to database`);
}

// Debug endpoints — only available in non-production environments
if (process.env.NODE_ENV !== 'production') {
  /**
   * GET /api/rtms/debug
   * Debug endpoint to check WebSocket connections
   */
  router.get('/debug', (req, res) => {
    const stats = getStats();
    console.log('🔍 WebSocket Debug Stats:', stats);
    res.json(stats);
  });

  /**
   * POST /api/rtms/debug-meeting
   * Debug endpoint to log what meeting ID the frontend is trying to connect with
   */
  router.post('/debug-meeting', (req, res) => {
    const { meetingId, source, fullContext } = req.body;
    console.log(`🔍 DEBUG: Meeting ID from ${source || 'unknown'}: "${meetingId}"`);
    console.log(`🔍 DEBUG: Full meeting context:`, JSON.stringify(fullContext, null, 2));
    if (fullContext) {
      console.log(`🔍 DEBUG: Context keys:`, Object.keys(fullContext));
    }
    res.json({ received: meetingId, contextKeys: fullContext ? Object.keys(fullContext) : [] });
  });
}

/**
 * Enrich a meeting record with metadata from Zoom REST API.
 * Fetches the meeting topic and numeric ID. Non-fatal on failure.
 */
async function enrichMeetingFromZoom(dbMeetingId, zoomMeetingUuid, ownerId) {
  // Double-encode UUID (Zoom requires this for UUIDs starting with / or containing //)
  const encodedUuid = encodeURIComponent(encodeURIComponent(zoomMeetingUuid));

  let zoomMeeting;
  try {
    zoomMeeting = await zoomGet(ownerId, `/meetings/${encodedUuid}`);
  } catch (err) {
    if (err.response?.status === 404) {
      // Try past_meetings endpoint as fallback
      try {
        zoomMeeting = await zoomGet(ownerId, `/past_meetings/${encodedUuid}`);
      } catch (fallbackErr) {
        console.warn(`⚠️ Could not fetch meeting from Zoom API (both endpoints failed)`);
        return;
      }
    } else {
      throw err;
    }
  }

  if (!zoomMeeting) return;

  const data = {};
  const genericPattern = /^Meeting \d{1,2}\/\d{1,2}\/\d{2,4}$/;

  // Update title if we got a real topic and current title is generic
  const currentMeeting = await prisma.meeting.findUnique({ where: { id: dbMeetingId } });
  if (zoomMeeting.topic && currentMeeting && genericPattern.test(currentMeeting.title)) {
    data.title = zoomMeeting.topic;
  }

  // Store the numeric meeting number if available
  if (zoomMeeting.id && currentMeeting && !currentMeeting.zoomMeetingNumber) {
    data.zoomMeetingNumber = String(zoomMeeting.id);
  }

  if (Object.keys(data).length > 0) {
    await prisma.meeting.update({ where: { id: dbMeetingId }, data });
    console.log(`✅ Enriched meeting: ${JSON.stringify(data)}`);
  }
}

module.exports = router;
