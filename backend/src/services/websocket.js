const WebSocket = require('ws');
const url = require('url');
const { verifySessionToken } = require('./auth');
const { verifyMeetingAccessToken } = require('./zoomAppContext');

/** Read a cookie from the upgrade request, if present. */
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Demo mode: No database - meeting data is not persisted

// Store active connections
const connections = new Map(); // meetingId -> Set of WebSocket connections
const userConnections = new Map(); // userId -> Set of WebSocket connections

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

    // Never log req.url: it may carry a token query parameter.
    //
    // Access model: every connection must present a meeting-access token
    // (httpOnly `meetingAccess` cookie, issued by POST /api/auth/meeting-access
    // after verifying the Zoom App Context). The token names exactly one
    // meeting, and the socket can only ever receive that meeting's data —
    // whatever meeting ID the client asks for. Guests get the same access as
    // signed-in users because the Zoom App Context proves they're in the meeting.
    let meetingId = null;
    let userId = null;

    const accessToken = getCookie(req, 'meetingAccess');
    if (accessToken) {
      try {
        const access = verifyMeetingAccessToken(accessToken);
        meetingId = access.meetingId;
        userId = access.userId || null;
      } catch (error) {
        console.warn('WebSocket meeting access rejected:', error.message);
      }
    }

    // Resolve the signed-in user from the session, if any (for per-user routing).
    const sessionToken = getCookie(req, 'sessionToken') || queryParams.token;
    if (sessionToken) {
      try {
        userId = verifySessionToken(sessionToken).userId;
      } catch {
        // Not signed in (or expired) — fine for guests.
      }
    }

    // Local development outside Zoom has no app context. Allow an explicitly
    // opted-in, signed-in developer to name a meeting directly.
    if (!meetingId && userId && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
        && process.env.NODE_ENV !== 'production' && typeof queryParams.meeting_id === 'string') {
      meetingId = queryParams.meeting_id;
      console.warn('⚠️  Dev mode: WebSocket bound to unverified meeting ID');
    }

    if (!meetingId) {
      ws.close(1008, 'Meeting access required');
      return;
    }

    const isGuest = !userId;

    // Store connection
    ws.userId = userId;
    ws.meetingId = meetingId;
    ws.allowedMeetingId = meetingId;
    ws.isAlive = true;
    ws.isGuest = isGuest;

    // Add to user connections (only for authenticated users)
    if (userId) {
      if (!userConnections.has(userId)) {
        userConnections.set(userId, new Set());
      }
      userConnections.get(userId).add(ws);
    }

    if (!connections.has(meetingId)) {
      connections.set(meetingId, new Set());
    }
    connections.get(meetingId).add(ws);

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
      console.log(`📡 WebSocket disconnected: ${userId ? `User ${userId}` : 'Guest'}`);

      // Remove from user connections (only for authenticated users)
      if (userId && userConnections.has(userId)) {
        userConnections.get(userId).delete(ws);
        if (userConnections.get(userId).size === 0) {
          userConnections.delete(userId);
        }
      }

      // Remove from meeting connections and broadcast updated presence
      const disconnectedMeetingId = ws.meetingId;
      if (disconnectedMeetingId && connections.has(disconnectedMeetingId)) {
        connections.get(disconnectedMeetingId).delete(ws);
        if (connections.get(disconnectedMeetingId).size === 0) {
          connections.delete(disconnectedMeetingId);
        } else {
          broadcastPresence(disconnectedMeetingId);
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
        meetingId,
        isGuest,
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

  console.log(`📨 WebSocket message: ${type}`);

  switch (type) {
    case 'subscribe':
      // Subscribe to a meeting
      const { participantName } = payload || {};
      // The client's requested meeting ID is ignored: a socket may only
      // subscribe to the meeting its verified access token names.
      const meetingId = ws.allowedMeetingId;
      if (meetingId) {
        // Remove from previous meeting if subscribed
        if (ws.meetingId && ws.meetingId !== meetingId && connections.has(ws.meetingId)) {
          connections.get(ws.meetingId).delete(ws);
          if (connections.get(ws.meetingId).size === 0) {
            connections.delete(ws.meetingId);
          }
        }
        ws.meetingId = meetingId;
        ws.participantName = typeof participantName === 'string' ? participantName.slice(0, 100) : null;
        if (!connections.has(meetingId)) {
          connections.set(meetingId, new Set());
        }
        connections.get(meetingId).add(ws);
        ws.send(JSON.stringify({
          type: 'subscribed',
          data: { meetingId },
        }));

        // Broadcast updated presence to all viewers in this meeting
        broadcastPresence(meetingId);

        // Demo mode: No database lookup - meeting status comes from RTMS events
        console.log(`📡 WS subscribe: demo mode - waiting for RTMS events for meetingId="${meetingId}"`);
      }
      break;

    case 'unsubscribe':
      // Unsubscribe from a meeting
      if (ws.meetingId && connections.has(ws.meetingId)) {
        connections.get(ws.meetingId).delete(ws);
        ws.send(JSON.stringify({
          type: 'unsubscribed',
          data: { meetingId: ws.meetingId },
        }));
        ws.meetingId = null;
      }
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

/**
 * Broadcast presence (viewer count + list) to all connections in a meeting.
 * Deduplicates by userId so a user with multiple WS connections counts once.
 */
function broadcastPresence(meetingId) {
  if (!connections.has(meetingId)) return;

  const clients = connections.get(meetingId);
  const viewers = [];
  const seenUserIds = new Set();
  let guestCount = 0;

  clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    // Deduplicate authenticated users by userId
    if (client.userId) {
      if (seenUserIds.has(client.userId)) return;
      seenUserIds.add(client.userId);
    }

    if (client.isGuest) {
      guestCount++;
    }
    viewers.push({
      name: client.participantName || (client.isGuest ? 'Guest' : 'User'),
      isGuest: client.isGuest,
    });
  });

  const message = JSON.stringify({
    type: 'meeting.presence',
    data: {
      meetingId,
      viewerCount: viewers.length,
      guestCount,
      viewers,
      timestamp: new Date().toISOString(),
    },
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/**
 * Broadcast message to all connections in a meeting
 */
function broadcastToMeeting(meetingId, message) {
  if (!connections.has(meetingId)) {
    console.log(`📡 No active connections for meeting ${meetingId}`);
    return 0;
  }

  const clients = connections.get(meetingId);
  const messageStr = JSON.stringify(message);
  let sentCount = 0;

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(messageStr);
        sentCount++;
      } catch (err) {
        console.error('WebSocket send error:', err.message);
      }
    }
  });

  console.log(`📡 Broadcast to ${sentCount} clients in meeting ${meetingId}`);
  return sentCount;
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
function broadcastTranscriptSegment(meetingId, segment) {
  return broadcastToMeeting(meetingId, {
    type: 'transcript.segment',
    data: {
      meetingId,
      segment,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Broadcast participant event (join/leave)
 */
function broadcastParticipantEvent(meetingId, event) {
  return broadcastToMeeting(meetingId, {
    type: 'participant.event',
    data: {
      meetingId,
      event,
      timestamp: new Date().toISOString(),
    },
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
function broadcastMeetingStatus(meetingId, status) {
  return broadcastToMeeting(meetingId, {
    type: 'meeting.status',
    data: {
      meetingId,
      status,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Tell a meeting why a stream request did not start (Zoom `rtms.request_status`).
 * Only the numeric status is sent; the operator id stays on the server.
 */
function broadcastRtmsRequestStatus(meetingId, status) {
  return broadcastToMeeting(meetingId, {
    type: 'rtms.request_status',
    data: {
      meetingId,
      status,
      timestamp: new Date().toISOString(),
    },
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
  if (!connections.has(rtmsMeetingId)) {
    connections.set(rtmsMeetingId, new Set());
  }

  let count = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      connections.get(rtmsMeetingId).add(ws);
      // Clean up old cross-registration if present
      if (ws.rtmsMeetingId && ws.rtmsMeetingId !== rtmsMeetingId && connections.has(ws.rtmsMeetingId)) {
        connections.get(ws.rtmsMeetingId).delete(ws);
        if (connections.get(ws.rtmsMeetingId).size === 0) {
          connections.delete(ws.rtmsMeetingId);
        }
      }
      ws.rtmsMeetingId = rtmsMeetingId;
      count++;
    }
  });

  if (count > 0) {
    console.log(`📡 Cross-registered ${count} WS connection(s) for user ${userId} under RTMS UUID "${rtmsMeetingId}"`);
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
  broadcastRtmsRequestStatus,
  crossRegisterUser,
  getStats,
};
