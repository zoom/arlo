const WebSocket = require('ws');
const url = require('url');
const { verifySessionToken } = require('./auth');
const { verifyMeetingAccessToken } = require('./zoomAppContext');
const { getMeetingLifecycle } = require('./meetingLifecycle');

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

/** Tell the lifecycle how many panels are connected for a meeting right now. */
function reportPanels(meetingId) {
  if (!meetingId) return;
  let open = 0;
  const clients = connections.get(meetingId);
  if (clients) {
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) open += 1;
    });
  }
  getMeetingLifecycle().panelsChanged(meetingId, open);
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
    // Cookie only: a token in the URL would end up in proxy and access logs.
    const sessionToken = getCookie(req, 'sessionToken');
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
    reportPanels(meetingId);

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
      console.log(`📡 WebSocket disconnected (${userId ? 'signed-in user' : 'guest'})`);

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
      reportPanels(disconnectedMeetingId);
      reportPanels(ws.rtmsMeetingId);
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
        reportPanels(meetingId); // counted again after an unsubscribe
        ws.send(JSON.stringify({
          type: 'subscribed',
          data: { meetingId },
        }));

        // Broadcast updated presence to all viewers in this meeting
        broadcastPresence(meetingId);

        // Tell the new subscriber whether a stream is already running
        const streamStatus = currentStreamStatus(meetingId);
        if (streamStatus) {
          ws.send(JSON.stringify({
            type: 'meeting.status',
            data: { meetingId, status: streamStatus, timestamp: new Date().toISOString() },
          }));
        }
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
        reportPanels(ws.meetingId);
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
    console.log('📡 No active connections for this meeting');
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

  console.log(`📡 Broadcast to ${sentCount} client(s)`);
  return sentCount;
}

/**
 * Broadcast message to all connections for a user
 */
function broadcastToUser(userId, message) {
  if (!userConnections.has(userId)) {
    console.log('📡 No active connections for this user');
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

  console.log(`📡 Broadcast to ${sentCount} of the user's client(s)`);
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
function broadcastMeetingStatus(meetingId, status, { fault = false } = {}) {
  rememberStreamStatus(meetingId, status);
  return broadcastToMeeting(meetingId, {
    type: 'meeting.status',
    data: {
      meetingId,
      status,
      // The stream ended because of a connection problem, not because someone stopped it
      ...(fault === true && { fault: true }),
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Which meetings have a live stream right now (in memory only, a status string
 * per meeting, no meeting content). Lets a panel that opens or reconnects
 * mid-meeting learn the real stream state from the server that receives it.
 */
const STREAM_STATUS_TTL_MS = 12 * 60 * 60 * 1000;
const STREAM_STATUS_MAX = 5000;
const streamStatuses = new Map(); // meetingId -> { status, at }

function rememberStreamStatus(meetingId, status) {
  const known = streamStatuses.has(meetingId);
  if (status === 'rtms_started') {
    if (!known && streamStatuses.size >= STREAM_STATUS_MAX) {
      // Drop the oldest entry (Map keeps insertion order) rather than grow without bound
      streamStatuses.delete(streamStatuses.keys().next().value);
    }
    streamStatuses.delete(meetingId);
    streamStatuses.set(meetingId, { status: 'rtms_started', at: Date.now() });
  } else if (status === 'rtms_stopped' || status === 'rtms_failed') {
    streamStatuses.delete(meetingId);
  } else if (known && (status === 'rtms_paused' || status === 'rtms_interrupted')) {
    // Pause/interrupt only change a stream that exists; they cannot create one
    streamStatuses.get(meetingId).status = status;
  } else if (known && status === 'rtms_resumed') {
    streamStatuses.get(meetingId).status = 'rtms_started';
  }
}

function currentStreamStatus(meetingId) {
  const entry = streamStatuses.get(meetingId);
  if (!entry) return null;
  if (Date.now() - entry.at > STREAM_STATUS_TTL_MS) {
    streamStatuses.delete(meetingId);
    return null;
  }
  return entry.status;
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
 * Close every socket a user has open (they removed the app). The panel
 * reconnects by itself as a plain meeting participant if it is still open.
 */
function disconnectUser(userId) {
  const clients = userConnections.get(userId);
  if (!clients) return 0;
  let closed = 0;
  for (const client of [...clients]) {
    try {
      client.close(4001, 'App deauthorized');
      closed += 1;
    } catch {
      // already closing
    }
  }
  return closed;
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
    console.log(`📡 Cross-registered ${count} WS connection(s) for the stream operator`);
    reportPanels(rtmsMeetingId);
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
  disconnectUser,
  crossRegisterUser,
  getStats,
};
