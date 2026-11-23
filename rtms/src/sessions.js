/**
 * RTMS session lifecycle.
 *
 * One session per stream (keyed by rtms_stream_id). This module holds the
 * rules: when a stream counts as started, what happens when a join is refused,
 * how a stream ends, and what is forwarded to the backend. It never imports
 * the Zoom RTMS SDK: the client is injected, so the rules can be tested with a
 * fake client (the real one is a native module that only runs in the container).
 *
 * Failover and reconnection follow Zoom's contract
 * (https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/):
 *   1. rtms_started again for a stream we hold  → rejoin at once with the new server URLs
 *   2. rtms_interrupted (signaling dropped)     → rejoin after a backoff, within ~60s
 *   3. media connection interrupted             → rejoin after a backoff, within ~30s
 *   4. rtms_stopped with a fault stop reason    → reported as a fault; the panel asks
 *                                                 Zoom for a new stream
 * The @zoom/rtms SDK only offers join() and leave(), so every reconnect is a
 * full rejoin with a new client (it cannot reconnect the media socket alone).
 * A closed connection is never rejoined on its own: Zoom's signal decides,
 * which avoids a duplicate connection to a stream Zoom has already ended.
 *
 * Nothing here is stored beyond the life of a stream, and nothing a person
 * said, their name, or a meeting or stream id is ever written to the logs.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ID_CHARS = 256;
const MAX_URL_CHARS = 2048;

// Backoff from Zoom's guide: 3s, doubling, capped at 30s. Never retry forever.
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
// A rejoin Zoom neither confirms nor refuses counts as a failed attempt
const JOIN_CONFIRM_TIMEOUT_MS = 15000;
// After the connection closed: how long to wait for Zoom to say what happened
// (its reconnection window is ~60s) before reporting the stream as lost
const AWAIT_ZOOM_SIGNAL_MS = 90000;
// A connection that held this long was a real recovery: the attempt count starts over
const STABLE_CONNECTION_MS = 60000;

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isServerUrls = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_URL_CHARS;

const reconnectDelay = (attempt) => Math.min(
  RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
  RECONNECT_MAX_DELAY_MS,
);

// RTMS stop reasons after which Zoom's guide says to start over: 10-19 and 24
// (exceptions, timeouts, interrupted or abnormally closed connections).
const isFaultStop = (reason) => Number.isInteger(reason)
  && ((reason >= 10 && reason <= 19) || reason === 24);
// Someone or something ended the stream on purpose (host, user, meeting ended, admin, API).
const isDeliberateStop = (reason) => Number.isInteger(reason)
  && ((reason >= 1 && reason <= 9) || (reason >= 20 && reason <= 23) || reason === 25 || reason === 26);

// RTMS stop reason 6: the stream ended because the meeting did
const MEETING_ENDED = 6;

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

function createSessionManager({
  createClient,
  backend,
  log = console,
  now = Date.now,
  defer = setImmediate,
  schedule = defaultSchedule, // (fn, ms) => cancel
  chaosDropAfterMs = 0, // testing only: drop the connection this long after each join
}) {
  const sessions = new Map(); // rtms_stream_id -> session

  // The backend being unreachable must never break a stream.
  const send = (label, promise) => Promise.resolve(promise).catch((error) => {
    log.warn(`Failed to send ${label} to the backend:`, error.message);
  });

  function findByMeeting(meetingUuid) {
    for (const [streamId, session] of sessions) {
      if (session.meetingUuid === meetingUuid) return { streamId, session };
    }
    return null;
  }

  function clearTimers(session) {
    for (const key of ['cancelTimer', 'cancelChaos']) {
      if (session[key]) session[key]();
      session[key] = null;
    }
  }

  /** Detach the current client so its late callbacks are ignored, and leave it. */
  function dropClient(session, { alreadyClosed = false } = {}) {
    const { client } = session;
    session.client = null;
    if (!client || alreadyClosed) return;
    try {
      client.leave();
    } catch (error) {
      log.warn('Error leaving an RTMS session:', error.message);
    }
  }

  /** Leave a stream we hold. `stopping` suppresses the SDK's teardown events. */
  function release(streamId, session) {
    session.stopping = true;
    clearTimers(session);
    sessions.delete(streamId);
    dropClient(session);
  }

  function onTranscript(session, data, timestamp, metadata) {
    const text = data.toString('utf-8');
    // First transcript marks the boundary between the initial roster and real joins
    session.firstTranscriptReceived = true;
    const userId = metadata?.userId;
    const userName = metadata?.userName;
    if (userId && userName) session.participantNames.set(String(userId), userName);

    session.seqCounter += 1;
    // Zoom timestamps are microseconds
    const tStartMs = typeof timestamp === 'number' ? Math.floor(timestamp / 1000) : now();
    send('a transcript segment', backend.segment(session.meetingUuid, {
      speakerId: userId ? String(userId) : 'unknown',
      speakerLabel: userName || (userId ? `Speaker ${userId}` : 'Speaker'),
      text: text || '',
      tStartMs,
      tEndMs: tStartMs,
      seqNo: session.seqCounter,
    }));
  }

  function onParticipants(session, event, participants) {
    const list = Array.isArray(participants) ? participants : [];
    const isJoin = event === 'join' || event === 'user_join';
    const isLeave = event === 'leave' || event === 'user_leave';
    // The SDK reports everyone as leaving while a stream is torn down
    if (session.stopping && isLeave) return;

    const idOf = (p) => (p.participantId ? String(p.participantId) : (p.userId ? String(p.userId) : null));
    if (isJoin) {
      list.forEach((p) => {
        const id = idOf(p);
        const name = p.userName || p.name;
        if (id && name) session.participantNames.set(id, name);
      });
    }

    const events = list.map((p) => {
      const id = idOf(p);
      let eventType = event;
      // The SDK reports people already in the meeting as "join" before any
      // transcript arrives: that is a roster, not people joining.
      if (isJoin) eventType = session.firstTranscriptReceived ? 'joined' : 'initial_roster';
      else if (isLeave) eventType = 'left';
      return {
        eventType,
        participantName: p.userName || p.name || session.participantNames.get(id) || `Participant ${id || 'unknown'}`,
        participantId: id,
        timestamp: now(),
      };
    });
    if (events.length > 0) send('participant events', backend.participantEvents(session.meetingUuid, events));
  }

  function newSession({ meetingUuid, streamId, serverUrls, operatorId }) {
    return {
      client: null,
      meetingUuid,
      streamId,
      serverUrls,
      // connecting → streaming; after a drop: waiting (for Zoom's signal) or backoff → connecting
      state: 'connecting',
      reconnecting: false, // true from the first rejoin until Zoom confirms one
      everJoined: false, // false while the first join is still being tried
      attempts: 0,
      joinedAt: 0,
      cancelTimer: null,
      cancelChaos: null,
      stopping: false,
      firstTranscriptReceived: false,
      participantNames: new Map(),
      startedAt: now(),
      operatorId: isId(operatorId) ? operatorId : null,
      seqCounter: 0,
    };
  }

  /** The first join failed: nothing to fall back on, so report it and let go. */
  function failStart(session) {
    send('status', backend.status(session.meetingUuid, 'rtms_failed'));
    release(session.streamId, session);
  }

  /** A join was refused, threw or was never confirmed. */
  function joinFailed(session) {
    if (session.reconnecting) scheduleReconnect(session);
    else failStart(session);
  }

  /** Rejoin after the backoff delay, or give up when the attempts are used up. */
  function scheduleReconnect(session) {
    clearTimers(session);
    dropClient(session);
    if (session.joinedAt && now() - session.joinedAt > STABLE_CONNECTION_MS) session.attempts = 0;
    session.joinedAt = 0;
    if (session.attempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`RTMS reconnect gave up after ${session.attempts} attempts`);
      failStart(session);
      return;
    }
    session.attempts += 1;
    session.reconnecting = true;
    session.state = 'backoff';
    const delay = reconnectDelay(session.attempts);
    log.log(`RTMS reconnect attempt ${session.attempts} of ${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    session.cancelTimer = schedule(() => {
      session.cancelTimer = null;
      if (sessions.get(session.streamId) === session) connect(session);
    }, delay);
  }

  /**
   * The connection closed and nobody ended the stream on purpose. Zoom decides
   * what happens next: rtms_interrupted or rtms_started (rejoin) or rtms_stopped.
   */
  function connectionLost(session, { alreadyClosed }) {
    clearTimers(session);
    dropClient(session, { alreadyClosed });
    session.state = 'waiting';
    send('status', backend.status(session.meetingUuid, 'rtms_interrupted'));
    session.cancelTimer = schedule(() => {
      session.cancelTimer = null;
      if (sessions.get(session.streamId) !== session) return;
      log.warn('No word from Zoom after the RTMS connection closed: reporting the stream as lost');
      sessions.delete(session.streamId);
      send('status', backend.status(session.meetingUuid, 'rtms_stopped', { fault: true }));
    }, AWAIT_ZOOM_SIGNAL_MS);
  }

  /** Create a client for the session and join the stream with it. */
  function connect(session) {
    const { meetingUuid, streamId } = session;
    clearTimers(session);
    session.state = 'connecting';
    // After a rejoin the SDK lists everyone again: that is a roster, not people joining
    session.firstTranscriptReceived = false;

    let client;
    try {
      client = createClient();
    } catch (error) {
      log.error('Could not create an RTMS client:', error.message);
      joinFailed(session);
      return;
    }
    session.client = client;
    // False for a client that was replaced, and for a session that ended
    const isCurrent = () => sessions.get(streamId) === session && session.client === client;

    client.onTranscriptData((data, size, timestamp, metadata) => {
      if (!isCurrent()) return;
      try {
        onTranscript(session, data, timestamp, metadata);
      } catch (error) {
        log.error('Error processing transcript data:', error.message);
      }
    });

    // 0 = joined. Anything else is an RTMS_STATUS_CODE and no media will flow
    // (16 = STATUS_DUPLICATE_MEDIA_DATA_CONNECTION). "Started" is only reported here.
    client.onJoinConfirm((reason) => {
      if (!isCurrent()) return;
      if (session.cancelTimer) { session.cancelTimer(); session.cancelTimer = null; }
      if (reason === 0) {
        // A first join that got in after a refusal is a start, not a reconnection
        const rejoined = session.reconnecting && session.everJoined;
        session.state = 'streaming';
        session.reconnecting = false;
        session.everJoined = true;
        session.joinedAt = now();
        log.log(rejoined ? 'Rejoined RTMS session' : 'Joined RTMS session');
        send('status', backend.status(
          meetingUuid,
          rejoined ? 'rtms_reconnected' : 'rtms_started',
          session.operatorId ? { operatorId: session.operatorId } : undefined,
        ));
        if (chaosDropAfterMs > 0) {
          session.cancelChaos = schedule(() => {
            session.cancelChaos = null;
            if (!isCurrent() || session.state !== 'streaming') return;
            log.warn('CHAOS: dropping the RTMS connection on purpose');
            connectionLost(session, { alreadyClosed: false });
          }, chaosDropAfterMs);
        }
        return;
      }
      log.error(`RTMS join refused by Zoom, status code ${reason}. See RTMS_STATUS_CODE in the Zoom RTMS docs.`);
      // Zoom announced the stream, so it keeps it open for about a minute: a
      // refusal is retried with the reconnect backoff, on a first join too
      // (seen 2026-11-23: status 16 on a start a few seconds after a stop, and
      // no new stream could be started until Zoom gave up on this one).
      // Handled outside the SDK callback so the next join is clean.
      defer(() => { if (isCurrent()) scheduleReconnect(session); });
    });

    // The connection closed. `reason` is an RTMS_STOP_REASON.
    client.onLeave((reason) => {
      log.log('RTMS connection closed, reason:', reason);
      if (session.stopping || !isCurrent()) return; // our own leave(), already handled
      if (isDeliberateStop(reason)) {
        clearTimers(session);
        sessions.delete(streamId);
        // The connection is closed, but the SDK client keeps polling and holds
        // its native handle until leave(). Released outside the SDK callback.
        session.stopping = true;
        defer(() => dropClient(session));
        // Tell the meeting now instead of waiting for the stopped webhook
        send('status', backend.status(
          meetingUuid,
          'rtms_stopped',
          reason === MEETING_ENDED ? { meetingEnded: true } : undefined,
        ));
        return;
      }
      if (session.reconnecting) {
        session.client = null; // already closed
        scheduleReconnect(session);
        return;
      }
      connectionLost(session, { alreadyClosed: true });
    });

    client.onSessionUpdate((event) => {
      log.log('Session update:', event);
    });

    // Scenario 3: media dropped while signaling survives. Zoom allows ~30s.
    client.onMediaConnectionInterrupted((timestamp) => {
      if (!isCurrent()) return;
      log.warn(`Media connection interrupted at ${timestamp}`);
      send('status', backend.status(meetingUuid, 'media_interrupted'));
      if (session.state === 'streaming') scheduleReconnect(session);
    });

    client.onParticipantEvent((event, timestamp, participants) => {
      if (!isCurrent()) return;
      try {
        onParticipants(session, event, participants);
      } catch (error) {
        log.error('Error processing participant event:', error.message);
      }
    });

    try {
      const result = client.join({
        meeting_uuid: meetingUuid,
        rtms_stream_id: streamId,
        server_urls: session.serverUrls,
      });
      log.log('Join result:', result);
    } catch (error) {
      log.error('Failed to join RTMS:', error.message);
      session.client = null;
      joinFailed(session);
      return;
    }
    if (session.reconnecting) {
      session.cancelTimer = schedule(() => {
        session.cancelTimer = null;
        if (!isCurrent()) return;
        log.warn('RTMS rejoin was not confirmed in time');
        joinFailed(session);
      }, JOIN_CONFIRM_TIMEOUT_MS);
    }
  }

  /** meeting.rtms_started */
  async function started(payload) {
    const meetingUuid = payload?.meeting_uuid;
    const streamId = payload?.rtms_stream_id;
    if (!isId(meetingUuid) || !isId(streamId)) {
      log.warn('rtms_started ignored: missing meeting or stream id');
      return;
    }
    const existing = sessions.get(streamId);
    if (existing) {
      if (existing.state === 'connecting' && payload.server_urls === existing.serverUrls) {
        log.log('Already connecting to this stream, ignoring duplicate webhook');
        return;
      }
      // Scenario 1: Zoom's RTMS server failed over. Same stream, possibly new URLs.
      log.log('rtms_started for a stream already held: server failover, rejoining');
      if (isServerUrls(payload.server_urls)) existing.serverUrls = payload.server_urls;
      const wasStreaming = existing.state === 'streaming';
      clearTimers(existing);
      dropClient(existing);
      existing.reconnecting = true;
      existing.attempts = 0;
      if (wasStreaming) send('status', backend.status(meetingUuid, 'rtms_interrupted'));
      connect(existing);
      return;
    }
    // A new stream id for a meeting we already hold replaces the old stream
    for (const [existingId, other] of sessions) {
      if (other.meetingUuid === meetingUuid) {
        log.log('New stream for a meeting already connected: replacing the old stream');
        release(existingId, other);
      }
    }

    const session = newSession({
      meetingUuid, streamId, serverUrls: payload.server_urls, operatorId: payload.operator_id,
    });
    // Stored before joining so a duplicate webhook during the join is ignored
    sessions.set(streamId, session);
    connect(session);
  }

  /**
   * meeting.rtms_interrupted (scenario 2): the signaling connection dropped and
   * Zoom keeps the stream for about 60 seconds. `eventTs` is the webhook's event_ts.
   */
  async function interrupted(payload, eventTs) {
    const meetingUuid = payload?.meeting_uuid;
    if (!isId(meetingUuid)) {
      log.warn('rtms_interrupted ignored: missing meeting id');
      return;
    }
    const streamId = isId(payload.rtms_stream_id) ? payload.rtms_stream_id : null;
    let session = (streamId && sessions.get(streamId)) || findByMeeting(meetingUuid)?.session || null;

    if (!session) {
      // Not a stream this process knows (it restarted mid-stream, for example)
      if (!streamId || !isServerUrls(payload.server_urls)) {
        log.warn('rtms_interrupted for a stream not held here, and no server URLs to rejoin it');
        send('status', backend.status(meetingUuid, 'rtms_interrupted'));
        return;
      }
      session = newSession({ meetingUuid, streamId, serverUrls: payload.server_urls });
      session.everJoined = true; // the stream was running before this process knew it
      sessions.set(streamId, session);
    } else {
      if (isServerUrls(payload.server_urls)) session.serverUrls = payload.server_urls;
      if (session.state === 'backoff' || (session.state === 'connecting' && session.reconnecting)) {
        log.log('rtms_interrupted while already reconnecting: nothing more to do');
        return;
      }
      // Sent before the connection we hold now was confirmed (our own rejoin can cause it)
      if (session.state === 'streaming' && Number.isFinite(eventTs) && eventTs <= session.joinedAt) {
        log.log('rtms_interrupted is older than the current connection: ignored');
        return;
      }
    }
    send('status', backend.status(meetingUuid, 'rtms_interrupted'));
    scheduleReconnect(session);
  }

  /** meeting.rtms_stopped (gives the meeting, sometimes the stream) */
  async function stopped(payload) {
    const meetingUuid = payload?.meeting_uuid;
    if (!isId(meetingUuid)) {
      log.warn('rtms_stopped ignored: missing meeting id');
      return;
    }
    const byStream = isId(payload.rtms_stream_id) ? sessions.get(payload.rtms_stream_id) : null;
    const found = byStream
      ? { streamId: payload.rtms_stream_id, session: byStream }
      : findByMeeting(meetingUuid);
    // Scenario 4: ended by a fault, not by a person. Also a stop that lands while
    // this service is recovering the connection, whatever reason Zoom gives.
    const recovering = Boolean(found) && (found.session.reconnecting || found.session.state === 'waiting');
    const fault = isFaultStop(payload.stop_reason) || recovering;
    if (found) {
      release(found.streamId, found.session);
      log.log(`RTMS session stopped${fault ? ' by a fault' : ''}`);
    }
    const meetingEnded = payload.stop_reason === MEETING_ENDED;
    const extra = { ...(fault && { fault: true }), ...(meetingEnded && { meetingEnded: true }) };
    await send('status', backend.status(
      meetingUuid,
      'rtms_stopped',
      Object.keys(extra).length > 0 ? extra : undefined,
    ));
  }

  /** Drop sessions older than 24 hours. Returns how many were dropped. */
  function sweep() {
    let swept = 0;
    for (const [streamId, session] of sessions) {
      if (now() - session.startedAt > SESSION_TTL_MS) {
        release(streamId, session);
        swept += 1;
      }
    }
    return swept;
  }

  function closeAll() {
    for (const [streamId, session] of sessions) release(streamId, session);
  }

  return { started, stopped, interrupted, sweep, closeAll, size: () => sessions.size };
}

module.exports = {
  createSessionManager,
  reconnectDelay,
  isFaultStop,
  SESSION_TTL_MS,
  MAX_RECONNECT_ATTEMPTS,
  JOIN_CONFIRM_TIMEOUT_MS,
  AWAIT_ZOOM_SIGNAL_MS,
  STABLE_CONNECTION_MS,
};
