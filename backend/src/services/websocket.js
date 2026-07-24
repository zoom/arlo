const WebSocket = require('ws');
const url = require('url');
const { verifyToken } = require('./auth');
const prisma = require('../lib/prisma');
const realtimeBus = require('./realtimeBus');
const config = require('../config');

// Store active connections
const connections = new Map(); // legacy meeting bucket, disabled for new fanout
const userConnections = new Map(); // userId -> Set of WebSocket connections
const zoomUserConnections = new Map(); // zoomUserId -> Set of WebSocket connections
const sessionConnections = new Map(); // RTMS stream/sessionId -> Set of WebSocket connections

function addToSetMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

function deleteFromSetMap(map, key, value) {
  if (!key || !map.has(key)) return;
  map.get(key).delete(value);
  if (map.get(key).size === 0) {
    map.delete(key);
  }
}

function wsMatchesEnvelopeIdentity(ws, envelope) {
  if (!ws.userId) return false;

  const envelopeMeetingIds = new Set([
    envelope.meetingId,
    envelope.rtmsMeetingId,
    envelope.sdkMeetingId,
  ].filter(Boolean));
  const meetingMatches = !envelopeMeetingIds.size ||
    envelopeMeetingIds.has(ws.meetingId) ||
    envelopeMeetingIds.has(ws.rtmsMeetingId);
  const streamMatches = !!(envelope.rtmsStreamId && ws.rtmsStreamId === envelope.rtmsStreamId);
  const sessionMatches = !!(envelope.clientSessionId && ws.clientSessionId === envelope.clientSessionId);

  if (meetingMatches && streamMatches) {
    return true;
  }

  if (envelope.appUserId && ws.appUserId === envelope.appUserId) {
    return meetingMatches || sessionMatches;
  }

  const envelopeZoomIds = [envelope.zoomUserId, envelope.operatorId].filter(Boolean);
  if (ws.zoomUserId && envelopeZoomIds.includes(ws.zoomUserId)) {
    return meetingMatches || sessionMatches;
  }

  return sessionMatches;
}

function addMapMatches(clients, map, key) {
  if (!key || !map.has(key)) return;
  map.get(key).forEach((ws) => clients.add(ws));
}

function collectEnvelopeClients(envelope) {
  const clients = new Set();
  addMapMatches(clients, userConnections, envelope.appUserId);
  addMapMatches(clients, zoomUserConnections, envelope.zoomUserId);
  addMapMatches(clients, zoomUserConnections, envelope.operatorId);
  addMapMatches(clients, sessionConnections, envelope.clientSessionId);
  addMapMatches(clients, sessionConnections, envelope.rtmsStreamId);
  return clients;
}

function sendRealtimeEnvelope(ws, envelope) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (!wsMatchesEnvelopeIdentity(ws, envelope)) return false;

  let message = null;
  switch (envelope.type) {
    case 'transcript.segment':
      message = {
        type: 'transcript.segment',
        data: {
          meetingId: envelope.meetingId,
          sessionId: envelope.rtmsStreamId || null,
          realtimeSessionId: envelope.sessionId,
          segment: envelope.segment,
          timestamp: new Date(envelope.publishedAt || Date.now()).toISOString(),
        },
      };
      break;
    case 'participant.event':
      message = {
        type: 'participant.event',
        data: {
          meetingId: envelope.meetingId,
          sessionId: envelope.rtmsStreamId || null,
          realtimeSessionId: envelope.sessionId,
          event: envelope.event,
          timestamp: new Date(envelope.publishedAt || Date.now()).toISOString(),
        },
      };
      break;
    case 'meeting.status':
      message = {
        type: 'meeting.status',
        data: {
          meetingId: envelope.meetingId,
          sessionId: envelope.rtmsStreamId || null,
          realtimeSessionId: envelope.sessionId,
          status: envelope.status,
          timestamp: new Date(envelope.publishedAt || Date.now()).toISOString(),
        },
      };
      break;
    default:
      return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

function broadcastRealtimeEnvelope(envelope) {
  if (!envelope?.meetingId) return 0;
  const clients = collectEnvelopeClients(envelope);

  if (clients.size === 0) {
    console.log(`📡 No active user/session connections for realtime meeting ${envelope.meetingId}`);
    return 0;
  }

  let sentCount = 0;
  clients.forEach((ws) => {
    if (sendRealtimeEnvelope(ws, envelope)) sentCount++;
  });
  console.log(`📡 Valkey realtime ${envelope.type} to ${sentCount} user/session client(s) for meeting ${envelope.meetingId}`);
  return sentCount;
}

/**
 * Initialize WebSocket server
 */
function initWebSocketServer(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/ws',  // Only accept connections at /ws path
  });

  wss.on('connection', async (ws, req) => {
    const queryParams = url.parse(req.url, true).query;
    const {
      meeting_uuid,
      meeting_id,
      meetingid,
      token,
      session_id,
      app_user_id,
      zoom_user_id,
      zoom_meeting_number,
    } = queryParams;
    const requestedMeetingId = meeting_uuid || meeting_id;
    const requestedRtmsStreamId = session_id || null;
    const requestedMeetingNumber = meetingid || zoom_meeting_number || null;

    const allowAnonymous = config.nodeEnv !== 'production' || process.env.ALLOW_ANONYMOUS_WS === 'true';
    console.log('📡 New WebSocket connection attempt', {
      path: '/ws',
      meetingId: requestedMeetingId || null,
      hasToken: !!token,
      hasSessionId: !!session_id,
    });

    // Verify token. Browser-supplied user IDs are hints only; the signed token is authoritative.
    let userId = null;
    let zoomUserId = null;
    if (token) {
      try {
        const payload = await verifyToken(token);
        userId = payload.userId;
        zoomUserId = payload.zoomUserId || null;
        console.log(`✅ WebSocket authenticated: User ${userId}`);
      } catch (error) {
        console.error('⚠️ WebSocket token verification failed:', error.message);
        ws.close(1008, 'Invalid authentication token');
        return;
      }
    } else if (!allowAnonymous) {
      console.error('❌ WebSocket token required in production');
      ws.close(1008, 'Authentication required');
      return;
    } else if (requestedMeetingId) {
      console.log(`📡 Anonymous development WebSocket connection for meeting: ${requestedMeetingId}`);
    } else {
      console.error('❌ WebSocket requires either token or meeting_id');
      ws.close(1008, 'Meeting ID required');
      return;
    }

    if (userId && app_user_id && app_user_id !== userId) {
      console.warn(`Rejected WebSocket user mismatch tokenUser=${userId} queryUser=${app_user_id}`);
      ws.close(1008, 'User identity mismatch');
      return;
    }

    if (zoomUserId && zoom_user_id && zoom_user_id !== zoomUserId) {
      console.warn(`Rejected WebSocket Zoom user mismatch tokenZoomUser=${zoomUserId} queryZoomUser=${zoom_user_id}`);
      ws.close(1008, 'Zoom user identity mismatch');
      return;
    }

    // Store connection
    ws.userId = userId;
    ws.appUserId = userId;
    ws.zoomUserId = zoomUserId;
    ws.clientAppUserIdHint = app_user_id || null;
    ws.clientZoomUserIdHint = zoom_user_id || null;
    ws.clientSessionId = null;
    ws.rtmsStreamId = requestedRtmsStreamId;
    ws.meetingID = requestedMeetingNumber;
    ws.zoomMeetingNumber = requestedMeetingNumber;
    ws.meetingId = requestedMeetingId;
    ws.isAlive = true;

    // Add to user connections
    addToSetMap(userConnections, ws.appUserId, ws);
    addToSetMap(zoomUserConnections, ws.zoomUserId, ws);
    addToSetMap(sessionConnections, ws.rtmsStreamId, ws);

    // Heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle messages
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        await handleWebSocketMessage(ws, data);
      } catch (error) {
        console.error('❌ WebSocket message error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message,
        }));
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      console.log(`📡 WebSocket disconnected: User ${userId}`);

      // Remove from user connections
      deleteFromSetMap(userConnections, ws.appUserId, ws);
      deleteFromSetMap(zoomUserConnections, ws.zoomUserId, ws);
      deleteFromSetMap(sessionConnections, ws.clientSessionId, ws);
      deleteFromSetMap(sessionConnections, ws.rtmsStreamId, ws);

      // Remove any legacy meeting-bucket registration left by older connections.
      const disconnectedMeetingId = ws.meetingId || requestedMeetingId;
      if (disconnectedMeetingId && connections.has(disconnectedMeetingId)) {
        connections.get(disconnectedMeetingId).delete(ws);
        if (connections.get(disconnectedMeetingId).size === 0) {
          connections.delete(disconnectedMeetingId);
        }
      }

      // Also clean up cross-registered RTMS UUID connection (SDK/RTMS mismatch)
      if (ws.rtmsMeetingId && connections.has(ws.rtmsMeetingId)) {
        connections.get(ws.rtmsMeetingId).delete(ws);
        if (connections.get(ws.rtmsMeetingId).size === 0) {
          connections.delete(ws.rtmsMeetingId);
        }
      }
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      data: {
        userId,
        meetingId: requestedMeetingId,
        rtmsStreamId: ws.rtmsStreamId,
        timestamp: new Date().toISOString(),
      },
    }));
  });

  // Heartbeat interval (every 30 seconds)
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('💀 Terminating inactive WebSocket connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  console.log('✅ WebSocket server initialized');

  return wss;
}

/**
 * Handle incoming WebSocket messages from clients
 */
async function handleWebSocketMessage(ws, data) {
  const { type, payload } = data;

  console.log(`📨 WebSocket message: ${type}`, payload);

  switch (type) {
    case 'subscribe':
      // Subscribe to a meeting
      const {
        meetingUUID,
        meetingId: legacyMeetingId,
        participantName,
        isGuest,
        sessionId,
        rtmsStreamId: payloadRtmsStreamId,
        appUserId,
        zoomUserId,
        meetingID: payloadMeetingID,
        zoomMeetingNumber,
      } = payload || {};
      const meetingId = meetingUUID || legacyMeetingId;
      const rtmsStreamId = payloadRtmsStreamId || sessionId || ws.rtmsStreamId || null;
      const numericMeetingID = payloadMeetingID || zoomMeetingNumber || ws.meetingID || null;
      if (meetingId) {
        // Remove from previous meeting if subscribed
        if (ws.meetingId && ws.meetingId !== meetingId && connections.has(ws.meetingId)) {
          connections.get(ws.meetingId).delete(ws);
          if (connections.get(ws.meetingId).size === 0) {
            connections.delete(ws.meetingId);
          }
        }
        ws.meetingId = meetingId;
        ws.participantName = participantName || null;
        ws.isGuest = !!isGuest;
        if (ws.userId && appUserId && appUserId !== ws.userId) {
          ws.send(JSON.stringify({ type: 'error', error: 'User identity mismatch' }));
          ws.close(1008, 'User identity mismatch');
          return;
        }
        if (ws.zoomUserId && zoomUserId && zoomUserId !== ws.zoomUserId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Zoom user identity mismatch' }));
          ws.close(1008, 'Zoom user identity mismatch');
          return;
        }

        ws.rtmsStreamId = rtmsStreamId;
        ws.clientSessionId = payload?.clientSessionId || ws.clientSessionId || null;
        ws.clientAppUserIdHint = appUserId || ws.clientAppUserIdHint || null;
        ws.clientZoomUserIdHint = zoomUserId || ws.clientZoomUserIdHint || null;
        ws.meetingID = ws.meetingID || numericMeetingID || null;
        ws.zoomMeetingNumber = ws.meetingID;
        addToSetMap(userConnections, ws.appUserId, ws);
        addToSetMap(zoomUserConnections, ws.zoomUserId, ws);
        addToSetMap(sessionConnections, ws.clientSessionId, ws);
        addToSetMap(sessionConnections, ws.rtmsStreamId, ws);

        let realtimeSession = null;
        if (ws.userId) {
          try {
            realtimeSession = await realtimeBus.resolveSession({
              meetingId,
              sessionId: ws.rtmsStreamId,
              rtmsStreamId: ws.rtmsStreamId,
            });

            if (realtimeSession?.rtmsMeetingId && realtimeSession.rtmsMeetingId !== meetingId) {
              ws.rtmsMeetingId = realtimeSession.rtmsMeetingId;
            }
          } catch (error) {
            console.warn('⚠️ Valkey client session registration failed:', error.message);
          }
        }

        ws.send(JSON.stringify({
          type: 'subscribed',
          data: {
            meetingId,
            sessionId: ws.rtmsStreamId || null,
            rtmsStreamId: ws.rtmsStreamId || null,
            realtimeSessionId: realtimeSession?.sessionId || null,
            rtmsMeetingId: realtimeSession?.rtmsMeetingId || null,
          },
        }));

        if (ws.userId && realtimeSession?.sessionId) {
          realtimeBus.replaySession(realtimeSession.sessionId, (envelope) => {
            sendRealtimeEnvelope(ws, envelope);
          }).then((count) => {
            if (count > 0) {
              console.log(`📡 Replayed ${count} Valkey event(s) to WS session ${realtimeSession.sessionId}`);
            }
          }).catch((err) => {
            console.warn('⚠️ Valkey replay failed:', err.message);
          });
        }

        sendPresence(ws, meetingId);

        // Check current meeting status and inform the subscriber
        console.log(`📡 WS subscribe: looking up meeting by zoomMeetingId="${meetingId}"`);
        prisma.meeting.findFirst({
          where: { zoomMeetingId: meetingId, ...(ws.userId && { ownerId: ws.userId }) },
        }).then(meeting => {
          if (!meeting && ws.userId) {
            // Fallback: SDK UUID may differ from RTMS UUID — find user's ongoing meeting
            return prisma.meeting.findFirst({
              where: { ownerId: ws.userId, status: 'ongoing' },
              orderBy: { startTime: 'desc' },
            });
          }
          return meeting;
        }).then(meeting => {
          if (!meeting) {
            console.log(`📡 WS subscribe: no meeting found for zoomMeetingId="${meetingId}"`);
            return;
          }

          // If found via fallback (different UUID), remember the RTMS UUID for cleanup/debug only.
          if (meeting.zoomMeetingId !== meetingId) {
            const rtmsUuid = meeting.zoomMeetingId;
            console.log(`📡 WS UUID fallback: SDK "${meetingId}" → RTMS "${rtmsUuid}"`);
            ws.rtmsMeetingId = rtmsUuid;
          }

          console.log(`📡 WS subscribe: found meeting id=${meeting.id}, status="${meeting.status}" for zoomMeetingId="${meetingId}"`);
          if (ws.readyState !== WebSocket.OPEN) return;
          if (meeting.status === 'ongoing') {
            ws.send(JSON.stringify({
              type: 'meeting.status',
              data: { meetingId, status: 'rtms_started', timestamp: new Date().toISOString() },
            }));
          } else if (meeting.status === 'completed') {
            ws.send(JSON.stringify({
              type: 'meeting.status',
              data: { meetingId, status: 'rtms_stopped', timestamp: new Date().toISOString() },
            }));
          }
        }).catch(err => {
          console.warn(`⚠️ WS subscribe: failed to look up zoomMeetingId="${meetingId}":`, err.message);
        });
      }
      break;

    case 'unsubscribe':
      // Unsubscribe from a meeting
      if (ws.meetingId && connections.has(ws.meetingId)) {
        connections.get(ws.meetingId).delete(ws);
      }
      ws.send(JSON.stringify({
        type: 'unsubscribed',
        data: { meetingId: ws.meetingId },
      }));
      ws.meetingId = null;
      break;

    case 'ping':
      // Respond to ping
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      console.warn(`⚠️ Unknown WebSocket message type: ${type}`);
  }
}

function sendPresence(ws, meetingId) {
  if (ws.readyState !== WebSocket.OPEN) return 0;
  const viewer = {
    name: ws.participantName || (ws.isGuest ? 'Guest' : 'User'),
    isGuest: !!ws.isGuest,
  };
  ws.send(JSON.stringify({
    type: 'meeting.presence',
    data: {
      meetingId,
      viewerCount: 1,
      guestCount: viewer.isGuest ? 1 : 0,
      viewers: [viewer],
      timestamp: new Date().toISOString(),
    },
  }));
  return 1;
}

/**
 * Meeting-wide presence is intentionally disabled to avoid cross-user disclosure.
 */
function broadcastPresence(meetingId) {
  console.log(`📡 Meeting-wide presence disabled for ${meetingId}`);
  return 0;
}

/**
 * Meeting-wide WebSocket fanout is intentionally disabled.
 */
function broadcastToMeeting(meetingId, message) {
  console.warn(`📡 Blocked meeting-wide WebSocket broadcast for ${meetingId}: ${message?.type || 'unknown'}`);
  return 0;
}

/**
 * Broadcast message to all connections for a user
 */
function broadcastToUser(userId, message) {
  if (!userConnections.has(userId)) {
    console.log(`📡 No active connections for user ${userId}`);
    return 0;
  }

  const clients = userConnections.get(userId);
  const messageStr = JSON.stringify(message);
  let sentCount = 0;

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sentCount++;
    }
  });

  console.log(`📡 Broadcast to ${sentCount} clients for user ${userId}`);
  return sentCount;
}

/**
 * Broadcast new transcript segment
 */
function broadcastTranscriptSegment(meetingId, segment, metadata = {}) {
  return broadcastRealtimeEnvelope({
    type: 'transcript.segment',
    meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
    sdkMeetingId: metadata.sdkMeetingId || null,
    rtmsStreamId: metadata.rtmsStreamId || null,
    appUserId: metadata.appUserId || null,
    zoomUserId: metadata.zoomUserId || null,
    operatorId: metadata.operatorId || null,
    clientSessionId: metadata.clientSessionId || null,
    segment,
    publishedAt: Date.now(),
  });
}

/**
 * Broadcast participant event (join/leave)
 */
function broadcastParticipantEvent(meetingId, event, metadata = {}) {
  return broadcastRealtimeEnvelope({
    type: 'participant.event',
    meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
    sdkMeetingId: metadata.sdkMeetingId || null,
    rtmsStreamId: metadata.rtmsStreamId || null,
    appUserId: metadata.appUserId || null,
    zoomUserId: metadata.zoomUserId || null,
    operatorId: metadata.operatorId || null,
    clientSessionId: metadata.clientSessionId || null,
    event,
    publishedAt: Date.now(),
  });
}

/**
 * Broadcast AI suggestion
 */
function broadcastAiSuggestion(meetingId, suggestion) {
  return broadcastToMeeting(meetingId, {
    type: 'ai.suggestion',
    data: {
      meetingId,
      suggestion,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Broadcast meeting status change
 */
function broadcastMeetingStatus(meetingId, status, metadata = {}) {
  return broadcastRealtimeEnvelope({
    type: 'meeting.status',
    meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
    sdkMeetingId: metadata.sdkMeetingId || null,
    rtmsStreamId: metadata.rtmsStreamId || null,
    appUserId: metadata.appUserId || null,
    zoomUserId: metadata.zoomUserId || null,
    operatorId: metadata.operatorId || null,
    clientSessionId: metadata.clientSessionId || null,
    status,
    publishedAt: Date.now(),
  });
}

/**
 * Cross-register a user's existing WS connections under an RTMS meeting UUID.
 * Called when a new RTMS session starts — the user's WS is subscribed under the
 * SDK UUID, but transcripts are broadcast under the RTMS UUID.
 */
function crossRegisterUser(userId, rtmsMeetingId) {
  if (!userConnections.has(userId)) return 0;

  const clients = userConnections.get(userId);
  let count = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.rtmsMeetingId = rtmsMeetingId;
      count++;
    }
  });

  if (count > 0) {
    console.log(`📡 Cross-registered ${count} WS connection(s) for user ${userId} under RTMS UUID "${rtmsMeetingId}"`);
  }
  return count;
}

function crossRegisterZoomUser(zoomUserId, rtmsMeetingId) {
  if (!zoomUserConnections.has(zoomUserId)) return 0;

  const clients = zoomUserConnections.get(zoomUserId);
  let count = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.rtmsMeetingId = rtmsMeetingId;
      count++;
    }
  });

  if (count > 0) {
    console.log(`📡 Cross-registered ${count} WS connection(s) for Zoom user ${zoomUserId} under RTMS UUID "${rtmsMeetingId}"`);
  }
  return count;
}

function crossRegisterSession(clientSessionId, rtmsMeetingId) {
  if (!sessionConnections.has(clientSessionId)) return 0;

  const clients = sessionConnections.get(clientSessionId);
  let count = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.rtmsMeetingId = rtmsMeetingId;
      count++;
    }
  });

  if (count > 0) {
    console.log(`📡 Cross-registered ${count} WS connection(s) for session ${clientSessionId} under RTMS UUID "${rtmsMeetingId}"`);
  }
  return count;
}

/**
 * Get connection statistics
 */
function getStats() {
  return {
    totalConnections: Array.from(connections.values()).reduce((sum, set) => sum + set.size, 0),
    activeMeetings: connections.size,
    activeUsers: userConnections.size,
    activeZoomUsers: zoomUserConnections.size,
    activeClientSessions: sessionConnections.size,
    meetingIds: Array.from(connections.keys()),
  };
}

module.exports = {
  initWebSocketServer,
  broadcastToMeeting,
  broadcastToUser,
  broadcastPresence,
  broadcastTranscriptSegment,
  broadcastParticipantEvent,
  broadcastAiSuggestion,
  broadcastMeetingStatus,
  crossRegisterUser,
  crossRegisterZoomUser,
  broadcastRealtimeEnvelope,
  getStats,
};
