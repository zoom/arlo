const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();
const config = require('../config');
const { broadcastTranscriptSegment, broadcastParticipantEvent, broadcastMeetingStatus, crossRegisterUser, crossRegisterZoomUser, getStats } = require('../services/websocket');
const realtimeBus = require('../services/realtimeBus');
const { zoomGet } = require('../services/zoomApi');
const prisma = require('../lib/prisma');

// Check if meeting persistence is disabled (demo mode)
const PERSISTENCE_DISABLED = config.disableMeetingPersistence;
if (PERSISTENCE_DISABLED) {
  console.log('⚠️ Meeting persistence DISABLED — transcripts will not be saved to database');
}

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

// Cache for meeting IDs -> database meeting records
const meetingCache = new Map();

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getRawBody(req) {
  return req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
}

function verifyZoomWebhook(req) {
  if (!config.rtmsWebhookSecret) {
    return { ok: false, reason: 'webhook_secret_not_configured' };
  }

  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  if (!signature || !timestamp) {
    return { ok: false, reason: 'missing_signature_headers' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const message = `v0:${timestamp}:${getRawBody(req)}`;
  const expected = `v0=${crypto
    .createHmac('sha256', config.rtmsWebhookSecret)
    .update(message)
    .digest('hex')}`;

  return timingSafeEqual(signature, expected)
    ? { ok: true }
    : { ok: false, reason: 'invalid_signature' };
}

function verifyInternalWebhook(req) {
  if (!config.internalWebhookSecret) {
    return {
      ok: config.nodeEnv !== 'production',
      reason: 'internal_webhook_secret_not_configured',
    };
  }

  const signature = req.headers['x-arlo-signature'];
  const timestamp = req.headers['x-arlo-request-timestamp'];
  if (!signature || !timestamp) {
    return { ok: false, reason: 'missing_internal_signature_headers' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_internal_timestamp' };
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_internal_timestamp' };
  }

  const message = `v0:${timestamp}:${getRawBody(req)}`;
  const expected = `v0=${crypto
    .createHmac('sha256', config.internalWebhookSecret)
    .update(message)
    .digest('hex')}`;

  return timingSafeEqual(signature, expected)
    ? { ok: true }
    : { ok: false, reason: 'invalid_internal_signature' };
}

function requireInternalRtmsRequest(req, res) {
  const verification = verifyInternalWebhook(req);
  if (verification.ok) return true;

  console.warn(`Rejected internal RTMS request path=${req.path} reason=${verification.reason}`);
  res.status(401).json({ error: 'invalid_internal_rtms_signature', reason: verification.reason });
  return false;
}

function buildInternalWebhookHeaders(body) {
  const headers = {
    'x-zm-signature': body.zoomSignature || '',
    'x-zm-request-timestamp': body.zoomTimestamp || '',
  };

  if (!config.internalWebhookSecret) {
    return headers;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const serializedBody = JSON.stringify(body.payload);
  headers['x-arlo-internal'] = 'true';
  headers['x-arlo-request-timestamp'] = timestamp;
  headers['x-arlo-signature'] = `v0=${crypto
    .createHmac('sha256', config.internalWebhookSecret)
    .update(`v0:${timestamp}:${serializedBody}`)
    .digest('hex')}`;
  return headers;
}

async function enrichRealtimeMetadataForMeeting(meetingId, metadata = {}) {
  const enriched = {
    ...metadata,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
  };

  if (enriched.appUserId && enriched.zoomUserId) {
    return enriched;
  }

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { zoomMeetingId: meetingId },
      select: {
        ownerId: true,
        owner: { select: { zoomUserId: true } },
      },
    });
    if (meeting?.ownerId) {
      enriched.appUserId = enriched.appUserId || meeting.ownerId;
      enriched.zoomUserId = enriched.zoomUserId || meeting.owner?.zoomUserId || null;
    }
  } catch (error) {
    console.warn('Could not enrich realtime metadata:', error.message);
  }

  return enriched;
}

/**
 * POST /api/rtms/webhook
 * Receive RTMS webhooks from Zoom
 */
router.post('/webhook', async (req, res) => {
  const { event, payload } = req.body;

  // Handle Zoom webhook validation (endpoint URL validation)
  if (event === 'endpoint.url_validation') {
    const plainToken = payload?.plainToken;
    if (!plainToken) {
      return res.status(400).json({ error: 'missing_plain_token' });
    }
    if (!config.rtmsWebhookSecret) {
      return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }

    const hash = crypto
      .createHmac('sha256', config.rtmsWebhookSecret)
      .update(plainToken)
      .digest('hex');

    return res.status(200).json({
      plainToken,
      encryptedToken: hash,
    });
  }

  const verification = verifyZoomWebhook(req);
  if (!verification.ok) {
    console.warn(`Rejected Zoom RTMS webhook event=${event || 'unknown'} reason=${verification.reason}`);
    const status = verification.reason === 'webhook_secret_not_configured' ? 500 : 401;
    return res.status(status).json({ error: 'invalid_zoom_webhook', reason: verification.reason });
  }

  console.log(`📨 RTMS Webhook: ${event}`);
  if (payload?.operator_id) {
    console.log(`📨 Operator ID: ${payload.operator_id}`);
  }

  // Forward webhook to RTMS service
  if (event === 'meeting.rtms_started' || event === 'meeting.rtms_stopped') {
    try {
      const rtmsServiceUrl = process.env.RTMS_SERVICE_URL || 'http://rtms:3002';
      const forwardRequest = {
        payload: req.body,
        zoomSignature: req.headers['x-zm-signature'],
        zoomTimestamp: req.headers['x-zm-request-timestamp'],
      };
      await axios.post(`${rtmsServiceUrl}/webhook`, forwardRequest.payload, {
        timeout: 5000,
        headers: buildInternalWebhookHeaders(forwardRequest),
      });
      console.log(`✅ Forwarded ${event} to RTMS service`);
    } catch (error) {
      console.error(`❌ Failed to forward webhook to RTMS service:`, error.message);
      // Ask Zoom to retry rather than silently losing a start/stop event.
      return res.status(503).json({ error: 'rtms_service_unavailable' });
    }
  }

  // Acknowledge webhook immediately
  res.status(200).send('OK');
});

/**
 * POST /api/rtms/status
 * Receive RTMS status updates from RTMS service
 */
router.post('/status', async (req, res) => {
  if (!requireInternalRtmsRequest(req, res)) return;

  const { meetingId, status, meetingTopic, operatorId, rtmsStreamId } = req.body;

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

  const realtimeMetadata = {
    rtmsMeetingId: meetingId,
    rtmsStreamId: rtmsStreamId || null,
    zoomUserId: operatorId || null,
    operatorId: operatorId || null,
    appUserId: null,
  };

  if (operatorId) {
    crossRegisterZoomUser(operatorId, meetingId);
  }

  if (dbMeetingId) {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { id: dbMeetingId },
        include: { owner: true },
      });
      if (meeting?.owner) {
        realtimeMetadata.appUserId = meeting.owner.id;
        realtimeMetadata.zoomUserId = meeting.owner.zoomUserId || realtimeMetadata.zoomUserId;
      }
    } catch (error) {
      console.warn('⚠️ Could not enrich realtime status metadata:', error.message);
    }
  }

  // Broadcast status change to WebSocket clients through Valkey when available.
  const publishedStatus = await realtimeBus.publishMeetingStatus(meetingId, status, realtimeMetadata);
  const sentCount = publishedStatus ? 0 : broadcastMeetingStatus(meetingId, status, realtimeMetadata);
  console.log(`📡 ${publishedStatus ? 'Published' : 'Broadcast'} status to ${publishedStatus ? 'Valkey' : `${sentCount} clients`}`);

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
    const publishedLifecycle = await realtimeBus.publishParticipantEvent(meetingId, lifecycleEvent, realtimeMetadata);
    if (!publishedLifecycle) {
      broadcastParticipantEvent(meetingId, lifecycleEvent, realtimeMetadata);
    }

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
    realtimeBus.deleteMeeting(meetingId, rtmsStreamId).catch((err) => {
      console.warn('⚠️ Valkey meeting cleanup failed:', err.message);
    });
  }

  res.status(200).json({ received: true, broadcast: sentCount });
});

/**
 * POST /api/rtms/broadcast
 * Receive transcript segments from RTMS service to broadcast to clients
 */
router.post('/broadcast', async (req, res) => {
  if (!requireInternalRtmsRequest(req, res)) return;

  const { meetingId, segment, publish = true, metadata = {} } = req.body;
  const stats = getStats();

  console.log(`📝 Transcript segment for meeting ${meetingId}: seq=${segment?.seqNo || 'n/a'} bytes=${Buffer.byteLength(segment?.text || '', 'utf8')}`);

  let sentCount = 0;
  let published = false;
  const realtimeMetadata = await enrichRealtimeMetadataForMeeting(meetingId, {
    ...metadata,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
  });
  if (realtimeMetadata.appUserId) {
    crossRegisterUser(realtimeMetadata.appUserId, meetingId);
  }
  if (realtimeMetadata.zoomUserId || realtimeMetadata.operatorId) {
    crossRegisterZoomUser(realtimeMetadata.zoomUserId || realtimeMetadata.operatorId, meetingId);
  }

  if (publish !== false) {
    published = await realtimeBus.publishTranscriptSegment(meetingId, segment, realtimeMetadata);
    if (!published) {
      sentCount = broadcastTranscriptSegment(meetingId, segment, realtimeMetadata);
    }
  } else {
    // RTMS already published to Valkey. Still fan out locally as a safety net so
    // a missed Valkey mapping/subscription does not drop live transcript delivery.
    sentCount = broadcastTranscriptSegment(meetingId, segment, realtimeMetadata);
  }
  console.log(`📡 ${published ? 'Published transcript to Valkey' : `Broadcast transcript to ${sentCount} clients`}`);

  // Save to database in the background (don't block the response)
  console.log('💾 Starting background save of transcript segment...');
  saveTranscriptSegment(meetingId, segment).catch(err => {
    console.error('❌ Failed to save transcript segment:', err.message);
    console.error('❌ Full error:', err);
  });

  res.status(200).json({ received: true, broadcast: sentCount, published });
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
  if (!requireInternalRtmsRequest(req, res)) return;

  const { meetingId, events, publish = true, metadata = {} } = req.body;

  console.log(`👥 Participant events for meeting ${meetingId}: count=${events.length}`);

  // Broadcast each event to WebSocket clients immediately
  let sentCount = 0;
  const realtimeMetadata = await enrichRealtimeMetadataForMeeting(meetingId, {
    ...metadata,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
  });
  if (realtimeMetadata.appUserId) {
    crossRegisterUser(realtimeMetadata.appUserId, meetingId);
  }
  if (realtimeMetadata.zoomUserId || realtimeMetadata.operatorId) {
    crossRegisterZoomUser(realtimeMetadata.zoomUserId || realtimeMetadata.operatorId, meetingId);
  }

  for (const event of events) {
    let published = false;
    if (publish !== false) {
      published = await realtimeBus.publishParticipantEvent(meetingId, event, realtimeMetadata);
    }
    if (!published) {
      sentCount += broadcastParticipantEvent(meetingId, event, realtimeMetadata);
    }
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
