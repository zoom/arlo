const WebSocket = require('ws');
const url = require('url');
const { verifySessionToken } = require('./auth');
const { restoreIfMissing, RESTORE_COOKIE } = require('./sessionRestore');
const deauthorized = require('../lib/deauthorized');
const { verifyMeetingAccessToken } = require('./zoomAppContext');
const { getMeetingLifecycle } = require('./meetingLifecycle');
const { getArloPresence } = require('./arloPresence');

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
 * Who a socket is.
 *
 * A socket is a signed-in user only through a valid session (`sessionToken`
 * cookie on the handshake, verified as the HTTP middleware verifies it). The
 * `meetingAccess` token says which meeting the socket is in and nothing else:
 * a user id inside it never makes the socket that user.
 *
 * A session can end while its socket stays open (it expires, or the user
 * removed the app). Sessions are signed tokens, not rows in a store, so "is
 * it still live" is two in-memory facts kept from the handshake: the token's
 * expiry time and whether its Zoom user was deauthorized since. userOf() checks
 * both every time anything reads the socket's user (owner-only sends, the
 * role in `arlo.state`, hands, presence), which costs a comparison and a map
 * lookup and re-verifies no token. A socket whose session ended becomes a
 * guest's socket on the spot and is told its new state. Logout and
 * deauthorization also close the user's sockets (disconnectUser).
 */
function sessionLive(ws) {
  const session = ws.session;
  if (!session) return false;
  if (typeof session.exp === 'number' && Date.now() > session.exp) return false;
  if (session.zoomUserId && deauthorized.isDeauthorized(session.zoomUserId)) return false;
  return true;
}

/** Remove a socket from its user's list. */
function unlistUserSocket(ws, userId) {
  const sockets = userConnections.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) userConnections.delete(userId);
}

/** From here on this is a guest's socket in its meeting. */
function makeGuest(ws) {
  const userId = ws.userId;
  ws.userId = null;
  ws.session = null;
  ws.isGuest = true;
  ws.arloHands = null;
  if (userId) unlistUserSocket(ws, userId);
}

/** The signed-in user of this socket right now, or null (a guest, or a session that ended). */
function userOf(ws) {
  if (!ws.userId) return null;
  if (!sessionLive(ws)) {
    makeGuest(ws);
    console.log('WebSocket session ended: the socket continues as a guest');
    // Told what it is now (sendArloState is a function declaration below)
    if (ws.readyState === WebSocket.OPEN && ws.allowedMeetingId) sendArloState(ws, ws.allowedMeetingId);
    return null;
  }
  return ws.userId;
}

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
    let session = null;

    const accessToken = getCookie(req, 'meetingAccess');
    if (accessToken) {
      try {
        // Meeting membership only. A user id in this token is not taken: who
        // the socket is comes from the session below, or it is a guest.
        meetingId = verifyMeetingAccessToken(accessToken).meetingId;
      } catch (error) {
        console.warn('WebSocket meeting access rejected:', error.message);
      }
    }

    // Resolve the signed-in user from the session, if any (for per-user routing).
    // Cookie only: a token in the URL would end up in proxy and access logs.
    const sessionToken = getCookie(req, 'sessionToken');
    if (sessionToken) {
      try {
        // As middleware/auth.js does: signature, expiry, not deauthorized, and
        // the user rebuilt from their restore cookie after a server restart
        const payload = verifySessionToken(sessionToken);
        restoreIfMissing({ cookies: { [RESTORE_COOKIE]: getCookie(req, RESTORE_COOKIE) } }, payload);
        userId = payload.userId;
        session = { zoomUserId: payload.zoomUserId || null, exp: typeof payload.exp === 'number' ? payload.exp : null };
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
    ws.session = session;
    ws.meetingId = meetingId;
    ws.allowedMeetingId = meetingId;
    ws.isAlive = true;
    ws.isGuest = isGuest;
    // For Arlo's hands (services/agent/hands.js): what this panel said it can
    // do with the Zoom Apps SDK, and since when it is connected
    ws.connectedAt = Date.now();
    ws.arloHands = null;

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
    notesReaderConnected(ws, meetingId);

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
      console.log(`📡 WebSocket disconnected (${ws.userId ? 'signed-in user' : 'guest'})`);

      // Remove from user connections (a socket whose session ended left already)
      if (userId) unlistUserSocket(ws, userId);

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
    // Whether Arlo is in the meeting and what this person is to it
    sendArloState(ws, meetingId);
  });

  // Heartbeat interval (every 30 seconds)
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      // A session that ended is noticed here at the latest (see userOf)
      userOf(ws);
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
        notesReaderConnected(ws, meetingId);
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
        sendArloState(ws, meetingId);
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

    case 'arlo.hands': {
      // What this panel can do for Arlo with the Zoom Apps SDK:
      // { zoomRole, can: [tool names] }. Kept on the socket, the newest one
      // counts. A claim only: whether this user is an owner of the meeting is
      // checked when an action is sent (services/agent/hands.js). Someone not
      // signed in has no hands, and what is not an announcement is ignored.
      // eslint-disable-next-line global-require
      const announced = require('./agent/hands').readHandsAnnouncement(payload);
      if (announced !== null && userOf(ws) && ws.allowedMeetingId) ws.arloHands = announced;
      break;
    }

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
    const clientUserId = userOf(client);
    if (clientUserId) {
      if (seenUserIds.has(clientUserId)) return;
      seenUserIds.add(clientUserId);
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
 * Send each socket of a meeting its own message: `buildMessage(ws)` returns the
 * message for that socket, or null for none. For anything that differs per
 * person (userOf(ws) is the signed-in Arlo user, or null). A socket that cannot
 * be built for or sent to does not stop the others. Returns how many were sent.
 */
function sendToMeetingSockets(meetingId, buildMessage) {
  const clients = connections.get(meetingId);
  if (!clients || typeof buildMessage !== 'function') return 0;
  let sentCount = 0;
  clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const message = buildMessage(ws);
      if (message === null || message === undefined) return;
      ws.send(JSON.stringify(message));
      sentCount += 1;
    } catch (err) {
      console.error('WebSocket send error:', err.message);
    }
  });
  return sentCount;
}

/**
 * What one panel is told about Arlo in its meeting: whether Arlo is there, and
 * whether this person brought it in (services/arloPresence.js). The message
 * differs per person, so it is never sent with broadcastToMeeting().
 */
const arloStateMessage = (ws, meetingId) => ({
  type: 'arlo.state',
  data: { meetingId, ...getArloPresence().stateFor(meetingId, userOf(ws)) },
});

/** Tell one socket, when it connects or subscribes. */
function sendArloState(ws, meetingId) {
  try {
    ws.send(JSON.stringify(arloStateMessage(ws, meetingId)));
  } catch (err) {
    console.error('WebSocket send error:', err.message);
  }
}

/**
 * Tell every panel of a meeting, after a stream started or stopped (someone's
 * role may have changed even when the meeting's status did not) or the
 * meeting's setting changed.
 */
function broadcastArloState(meetingId) {
  return sendToMeetingSockets(meetingId, (ws) => arloStateMessage(ws, meetingId));
}

const userIdSet = (ids) => new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0));

/**
 * A panel of one of these people, verified to be in this meeting. A guest's
 * socket (no user) never matches. Nor does an owner's panel in another
 * meeting, which crossRegisterUser() lists under this meeting too.
 */
const isOwnerPanel = (ws, meetingId, owners) => ws.allowedMeetingId === meetingId && owners.has(userOf(ws));

/** Whether the meeting's owners share its notes with everyone, read now. A lookup that fails says no. */
function notesSharedIn(meetingId) {
  try {
    return getArloPresence().notesShared(meetingId) === true;
  } catch {
    return false;
  }
}

/**
 * Who may see a meeting's notes: an owner's panel, and while the notes are
 * shared every socket whose verified meeting access names this meeting,
 * signed in or a guest. Never a socket verified for another meeting, though it
 * may be listed under this one: notes are shown only where the person was
 * verified to be.
 */
const mayReadNotes = (ws, meetingId, owners, shared) => ws.allowedMeetingId === meetingId
  && (shared === true || isOwnerPanel(ws, meetingId, owners));

/**
 * Send a meeting's notes to the people who may see them (mayReadNotes), and to
 * nobody else. Whether the notes are shared is read here, at the time of
 * sending: the moment an owner stops sharing, only owners get them.
 */
function sendNotesUpdated(meetingId, ownerUserIds, notes) {
  const owners = userIdSet(ownerUserIds);
  const shared = notesSharedIn(meetingId);
  if (owners.size === 0 && !shared) return 0;
  return sendToMeetingSockets(meetingId, (ws) => (
    mayReadNotes(ws, meetingId, owners, shared)
      ? { type: 'notes.updated', data: { meetingId, notes } }
      : null
  ));
}

/**
 * Tell the owners' panels that someone asks for their approval
 * (services/approvals.js). Owners' sockets verified for this meeting, and
 * nobody else: `data` carries the asker's name and, for something Arlo was
 * asked, the text that would be posted. `ownerUserIds` is every owner, or for
 * a sheet only some panels can act on (admitting needs a host's) those owners.
 */
function sendApprovalOpened(meetingId, ownerUserIds, data) {
  const owners = userIdSet(ownerUserIds);
  if (owners.size === 0) return 0;
  return sendToMeetingSockets(meetingId, (ws) => (
    isOwnerPanel(ws, meetingId, owners) ? { type: 'arlo.approval', data } : null
  ));
}

/**
 * Tell how an approval ended: to the owners' panels and to the panels of the
 * person who asked, each verified to be in this meeting. Nobody else.
 */
function sendApprovalClosed(meetingId, ownerUserIds, askedByUserId, data) {
  const told = userIdSet(ownerUserIds);
  if (typeof askedByUserId === 'string' && askedByUserId.length > 0) told.add(askedByUserId);
  if (told.size === 0) return 0;
  return sendToMeetingSockets(meetingId, (ws) => (
    isOwnerPanel(ws, meetingId, told) ? { type: 'arlo.approval.closed', data } : null
  ));
}

const MAX_THINKING_STEP_CHARS = 120;
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Tell these people's panels, each verified to be in this meeting, that Arlo
 * is handling a request, or that it stopped. Who they are is the agent's
 * decision (services/agent/agent.js): the owners for a request spoken in the
 * meeting; for a typed one only the owner who typed it, so another owner does
 * not learn that someone asked something in private. `detail`: { step, channel }
 * with "on". Nothing of it is logged.
 */
function sendArloThinking(meetingId, userIds, on, detail) {
  const told = userIdSet(userIds);
  if (told.size === 0) return 0;
  const data = { meetingId, on: on === true };
  // With "on" only: what Arlo is doing right now, a sentence the server wrote
  // (services/agent/texts.js), and how it was asked. Anything else is left out.
  if (data.on && detail !== null && typeof detail === 'object') {
    const { step, channel } = detail;
    if (typeof step === 'string' && step.length > 0 && step.length <= MAX_THINKING_STEP_CHARS && !CONTROL_CHARACTER.test(step)) {
      data.step = step;
    }
    if (channel === 'voice' || channel === 'panel') data.channel = channel;
  }
  return sendToMeetingSockets(meetingId, (ws) => (
    isOwnerPanel(ws, meetingId, told) ? { type: 'arlo.thinking', data } : null
  ));
}

/**
 * Tell how something Arlo was asked ended (services/agent/agent.js decides who
 * may know): with `everyone`, every socket whose verified meeting access names
 * this meeting, signed in or a guest; otherwise the panels of `userIds` only.
 * Never a socket verified for another meeting. `action` is the stored action:
 * a tool name, a label the server wrote, the asker's name, a status.
 */
function sendArloDid(meetingId, action, { everyone = false, userIds = [] } = {}) {
  const told = userIdSet(userIds);
  if (everyone !== true && told.size === 0) return 0;
  return sendToMeetingSockets(meetingId, (ws) => (
    ws.allowedMeetingId === meetingId && (everyone === true || told.has(userOf(ws)))
      ? { type: 'arlo.did', data: { meetingId, action } }
      : null
  ));
}

/**
 * The open panels that announced hands (`arlo.hands`) and are verified to be
 * in this meeting, each with a way to send it a message. Never a guest's
 * socket, and never one verified for another meeting, though it may be listed
 * under this one. Whether its user is an owner is for the caller to check.
 */
function handsPanels(meetingId) {
  const clients = connections.get(meetingId);
  if (!clients) return [];
  const panels = [];
  clients.forEach((ws) => {
    const userId = userOf(ws);
    if (ws.readyState !== WebSocket.OPEN || ws.allowedMeetingId !== meetingId || !userId || !ws.arloHands) return;
    panels.push({
      userId,
      zoomRole: ws.arloHands.zoomRole,
      can: [...ws.arloHands.can],
      since: ws.connectedAt,
      send(message) {
        // Not to a socket whose session ended since it was listed
        if (ws.readyState !== WebSocket.OPEN || userOf(ws) !== userId) return false;
        try {
          ws.send(JSON.stringify(message));
          return true;
        } catch {
          return false;
        }
      },
    });
  });
  return panels;
}

/**
 * Whether a panel that may see this meeting's notes is open in it: an owner's
 * (one of `ownerUserIds`), or anyone's while the notes are shared. The same
 * sockets sendNotesUpdated() would send to. The notes engine asks before it
 * writes notes, so none are written (and no transcript goes to the AI
 * provider for them) while nobody could read them.
 */
function hasNotesReaderPanel(meetingId, ownerUserIds) {
  const owners = userIdSet(ownerUserIds);
  const shared = notesSharedIn(meetingId);
  const clients = connections.get(meetingId);
  if (!clients || (owners.size === 0 && !shared)) return false;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && mayReadNotes(ws, meetingId, owners, shared)) return true;
  }
  return false;
}

/**
 * Whether one of these people (the meeting's owners) has a panel open in the
 * meeting: signed in, and verified to be in it. The owner half of the check
 * above, without the sharing half: a participant who reads shared notes
 * cannot approve or do anything for Arlo. The agent asks before it sends a
 * spoken request to a model (services/agent/agent.js).
 */
function hasOwnerPanel(meetingId, ownerUserIds) {
  const owners = userIdSet(ownerUserIds);
  const clients = connections.get(meetingId);
  if (!clients || owners.size === 0) return false;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && isOwnerPanel(ws, meetingId, owners)) return true;
  }
  return false;
}

/**
 * A panel connected or subscribed: if it may see the notes (an owner's, or
 * anyone's while they are shared) and lines are waiting to be written up, the
 * notes engine takes it from here. The engine decides; this only wakes it.
 */
function notesReaderConnected(ws, meetingId) {
  try {
    // Required here: the notes engine's neighbours require this module
    // eslint-disable-next-line global-require
    require('./notesEngine').getNotesEngine().ownerPanelConnected(meetingId);
  } catch {
    // A panel connecting must never fail because of the notes
  }
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
function broadcastMeetingStatus(meetingId, status, { fault = false, meetingEnded = false } = {}) {
  rememberStreamStatus(meetingId, status);
  return broadcastToMeeting(meetingId, {
    type: 'meeting.status',
    data: {
      meetingId,
      status,
      // The stream ended because of a connection problem, not because someone stopped it
      ...(fault === true && { fault: true }),
      // The stream stopped because the meeting is over: its data is deleted now
      ...(meetingEnded === true && { meetingEnded: true }),
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
 * Close every socket a user has open (they signed out, or removed the app).
 * Each stops being that user's at once, before the close completes. A panel
 * that is still open reconnects by itself and, without a session, comes back
 * as a guest in its meeting.
 */
function disconnectUser(userId, reason = 'App deauthorized') {
  const clients = userConnections.get(userId);
  if (!clients) return 0;
  let closed = 0;
  for (const client of [...clients]) {
    makeGuest(client);
    try {
      client.close(4001, reason === 'Signed out' ? 'Signed out' : 'App deauthorized');
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
  [...clients].forEach(ws => {
    // Only a socket that is still this user's (userOf drops one whose session ended)
    if (ws.readyState === WebSocket.OPEN && userOf(ws) === userId) {
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
  broadcastArloState,
  sendToMeetingSockets,
  sendNotesUpdated,
  sendApprovalOpened,
  sendApprovalClosed,
  sendArloThinking,
  sendArloDid,
  handsPanels,
  hasNotesReaderPanel,
  hasOwnerPanel,
  currentStreamStatus,
  broadcastRtmsRequestStatus,
  disconnectUser,
  crossRegisterUser,
  getStats,
};
