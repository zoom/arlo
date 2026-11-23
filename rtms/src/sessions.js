/**
 * RTMS session lifecycle.
 *
 * One session per stream (keyed by rtms_stream_id). A meeting can have several
 * streams at once: each Zoom user can run one of their own, with its own stream
 * id under the same meeting UUID. They are all kept, and every report to the
 * backend says which stream it is about; the backend stores each line once,
 * whichever streams deliver it. This module holds the
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

const crypto = require('node:crypto');
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
// A pause or resume report the backend did not take (it was reloading) is sent
// again after these delays, then given up: nothing else would correct it
// before the next pause or resume.
const PAUSE_REPORT_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000]);

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

// What the SDK's onSessionUpdate(op) reports: the values of @zoom/rtms's
// SESSION_EVENT_PAUSE and SESSION_EVENT_RESUME (SESSION_EVENT_ADD is 1,
// SESSION_EVENT_STOP 2). Defined here because this module never imports the SDK.
const SESSION_EVENT_PAUSE = 3;
const SESSION_EVENT_RESUME = 4;

// Keys the log tags below. Made once per process and kept nowhere else: a tag
// tells two ids apart within one run, cannot be compared with another run's,
// and cannot be found by hashing a guessed id.
const LOG_TAG_SALT = crypto.randomBytes(16);

/**
 * Whether a session update is about the stream this connection joined. A
 * connection also hears of other sessions and streams (a second person starting
 * Arlo in the same meeting shows up on the first person's connection). An
 * update is taken to be about another stream only when it names a stream id
 * that differs from the joined one AND this connection has already shown that
 * the SDK's stream ids are the same ids as the webhook's (an earlier update
 * named the joined stream). Until then every update counts as ours: a pause
 * made with Zoom's own controls was seen working that way in a real meeting,
 * and that must not be lost to an id that merely looks different.
 */
function isAboutJoinedStream(info, joinedStreamId, idsComparable) {
  if (!info || typeof info !== 'object') return true;
  if (typeof info.streamId !== 'string' || info.streamId.length === 0) return true;
  if (info.streamId === joinedStreamId) return true;
  return !idsComparable;
}

/**
 * What a session update is about, for the log, without any id: whether it names
 * the stream this connection joined, and a short tag that tells two sessions
 * apart (a second person starting Arlo in the same meeting shows up as another
 * session on the first person's connection, with no webhook of its own).
 */
function describeSessionInfo(info, joinedStreamId) {
  if (!info || typeof info !== 'object') return '(no session info)';
  const tag = (value) => (typeof value === 'string' && value.length > 0
    ? crypto.createHmac('sha256', LOG_TAG_SALT).update(value).digest('hex').slice(0, 6)
    : 'none');
  const flag = (value) => (typeof value === 'boolean' ? value : 'n/a');
  return `(session #${tag(info.sessionId)}, stream #${tag(info.streamId)}, same stream as joined: ${info.streamId === joinedStreamId}, active: ${flag(info.isActive)}, paused: ${flag(info.isPaused)})`;
}

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

  /** Tell the backend what happened to one stream. */
  const report = (meetingUuid, streamId, status, extra = {}) => send('status', backend.status(
    meetingUuid,
    status,
    { ...(streamId && { streamId }), ...extra },
  ));
  const reportFor = (session, status, extra) => report(session.meetingUuid, session.streamId, status, extra);

  /**
   * Which stream a line or participant event comes from, and whose it is. Sent
   * with every one, so a backend that restarted mid-meeting (and so never saw
   * this stream's start report) still knows who brought Arlo in.
   */
  const whose = (session) => ({
    streamId: session.streamId,
    ...(session.operatorId && { operatorId: session.operatorId }),
    ...(session.originalHost && { originalHost: true }),
  });

  const sessionsOf = (meetingUuid) => [...sessions.values()].filter((s) => s.meetingUuid === meetingUuid);

  /**
   * The session a stopped or interrupted webhook is about. A webhook that names
   * a stream means that stream and no other. One that names none can only mean
   * the meeting's stream when there is exactly one: with several, guessing
   * would end or rejoin another user's stream.
   * Returns { session } (null = not held here) or { ambiguous: true }.
   */
  function sessionFor(meetingUuid, streamId) {
    if (streamId) return { session: sessions.get(streamId) || null };
    const held = sessionsOf(meetingUuid);
    if (held.length > 1) return { ambiguous: true };
    return { session: held[0] || null };
  }

  /** Stop sending a pause or resume report that has not got through. */
  function dropPauseReport(session) {
    const pending = session.pauseReport;
    session.pauseReport = null;
    if (pending && pending.cancel) pending.cancel();
  }

  /**
   * Tell the backend that this stream was paused or resumed, and try again when
   * it does not take the report. Only the last word counts: a new report, or
   * the session ending, drops the one before, so a "paused" still waiting is
   * never delivered after a "resumed". Never throws: it is called from an SDK
   * callback, and the backend being unreachable must not break the stream.
   */
  function reportPauseChange(session, status) {
    dropPauseReport(session);
    const pending = { cancel: null };
    session.pauseReport = pending;
    const wanted = () => sessions.get(session.streamId) === session && session.pauseReport === pending;
    const attempt = (retriesMade) => {
      let sending;
      try {
        sending = Promise.resolve(backend.status(session.meetingUuid, status, { streamId: session.streamId }));
      } catch (error) {
        sending = Promise.reject(error);
      }
      sending.then(() => {
        if (session.pauseReport === pending) session.pauseReport = null;
      }, (error) => {
        log.warn('Failed to send status to the backend:', error && error.message);
        if (!wanted()) return;
        if (retriesMade >= PAUSE_REPORT_RETRY_DELAYS_MS.length) {
          session.pauseReport = null;
          log.warn(`A pause or resume report was given up after ${retriesMade + 1} attempts`);
          return;
        }
        pending.cancel = schedule(() => {
          pending.cancel = null;
          if (wanted()) attempt(retriesMade + 1);
        }, PAUSE_REPORT_RETRY_DELAYS_MS[retriesMade]);
      });
    };
    attempt(0);
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
    dropPauseReport(session);
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
    }, whose(session)));
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
    if (events.length > 0) {
      send('participant events', backend.participantEvents(session.meetingUuid, events, whose(session)));
    }
  }

  function newSession({ meetingUuid, streamId, serverUrls, operatorId, originalHost }) {
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
      // The pause or resume report still being sent or retried: { cancel } or null
      pauseReport: null,
      stopping: false,
      firstTranscriptReceived: false,
      participantNames: new Map(),
      startedAt: now(),
      operatorId: isId(operatorId) ? operatorId : null,
      // The stream of the meeting's original host. Only the boolean counts.
      originalHost: originalHost === true,
      seqCounter: 0,
    };
  }

  /** The first join failed: nothing to fall back on, so report it and let go. */
  function failStart(session) {
    reportFor(session, 'rtms_failed');
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
    reportFor(session, 'rtms_interrupted');
    session.cancelTimer = schedule(() => {
      session.cancelTimer = null;
      if (sessions.get(session.streamId) !== session) return;
      log.warn('No word from Zoom after the RTMS connection closed: reporting the stream as lost');
      dropPauseReport(session);
      sessions.delete(session.streamId);
      reportFor(session, 'rtms_stopped', { fault: true });
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
        // Who runs this stream goes with both, so a backend that restarted
        // mid-meeting learns it from the next rejoin
        reportFor(session, rejoined ? 'rtms_reconnected' : 'rtms_started', {
          ...(session.operatorId && { operatorId: session.operatorId }),
          ...(session.originalHost && { originalHost: true }),
        });
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
        dropPauseReport(session);
        sessions.delete(streamId);
        // The connection is closed, but the SDK client keeps polling and holds
        // its native handle until leave(). Released outside the SDK callback.
        session.stopping = true;
        defer(() => dropClient(session));
        // Tell the meeting now instead of waiting for the stopped webhook
        reportFor(session, 'rtms_stopped', reason === MEETING_ENDED ? { meetingEnded: true } : undefined);
        return;
      }
      if (session.reconnecting) {
        session.client = null; // already closed
        scheduleReconnect(session);
        return;
      }
      connectionLost(session, { alreadyClosed: true });
    });

    // Someone paused or resumed this stream, with Arlo's button or with Zoom's
    // own controls ("Apps that access meeting content"). Zoom sends no webhook
    // for it: this is the only place it is heard of. The same callback also
    // hears of other sessions and streams on this connection: those are logged
    // and change nothing here.
    client.onSessionUpdate((op, info) => {
      log.log('Session update:', typeof op === 'number' ? op : 'unexpected form', describeSessionInfo(info, streamId));
      if (!isCurrent()) return;
      // Any update that names the joined stream proves the SDK's ids can be compared
      if (info && typeof info === 'object' && info.streamId === streamId) session.sdkNamesJoinedStream = true;
      if (session.state !== 'streaming') return;
      if (op !== SESSION_EVENT_PAUSE && op !== SESSION_EVENT_RESUME) return;
      if (!isAboutJoinedStream(info, streamId, session.sdkNamesJoinedStream === true)) {
        log.log('Session update is not about the joined stream: nothing reported');
        return;
      }
      reportPauseChange(session, op === SESSION_EVENT_PAUSE ? 'rtms_paused' : 'rtms_resumed');
    });

    // Scenario 3: media dropped while signaling survives. Zoom allows ~30s.
    client.onMediaConnectionInterrupted((timestamp) => {
      if (!isCurrent()) return;
      log.warn(`Media connection interrupted at ${timestamp}`);
      reportFor(session, 'media_interrupted');
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
      if (wasStreaming) reportFor(existing, 'rtms_interrupted');
      connect(existing);
      return;
    }
    // A new stream id in a meeting already held is another user's stream, and
    // both are kept. Only the same user starting again replaces their old one.
    // Streams whose user is not known are never taken for the same user.
    const operatorId = isId(payload.operator_id) ? payload.operator_id : null;
    for (const other of sessionsOf(meetingUuid)) {
      if (operatorId && other.operatorId === operatorId) {
        log.log('The same user started a new stream in this meeting: replacing their old stream');
        release(other.streamId, other);
        // Nothing else will ever say so: Zoom may send no stop for a stream it
        // replaced, and without this report the backend would count the old
        // stream as running for good, also when the new one cannot be joined.
        // Not a fault, and the meeting goes on. `replaced` tells the backend
        // that a new stream of the same user is being joined right now: it
        // waits for that stream's start or failure before it shows a stop.
        reportFor(other, 'rtms_stopped', { replaced: true });
      }
    }

    const session = newSession({
      meetingUuid,
      streamId,
      serverUrls: payload.server_urls,
      operatorId,
      originalHost: payload.is_original_host,
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
    const found = sessionFor(meetingUuid, streamId);
    if (found.ambiguous) {
      log.warn('rtms_interrupted without a stream id for a meeting with several streams: ignored');
      return;
    }
    let { session } = found;

    if (!session) {
      // Not a stream this process knows (it restarted mid-stream, for example)
      if (!streamId || !isServerUrls(payload.server_urls)) {
        log.warn('rtms_interrupted for a stream not held here, and no server URLs to rejoin it');
        report(meetingUuid, streamId, 'rtms_interrupted');
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
    reportFor(session, 'rtms_interrupted');
    scheduleReconnect(session);
  }

  /** meeting.rtms_stopped (gives the meeting, and the stream when Zoom names it) */
  async function stopped(payload) {
    const meetingUuid = payload?.meeting_uuid;
    if (!isId(meetingUuid)) {
      log.warn('rtms_stopped ignored: missing meeting id');
      return;
    }
    const namedStreamId = isId(payload.rtms_stream_id) ? payload.rtms_stream_id : null;
    const found = sessionFor(meetingUuid, namedStreamId);
    if (found.ambiguous) {
      log.warn('rtms_stopped without a stream id for a meeting with several streams: ignored');
      return;
    }
    const { session } = found;
    // Scenario 4: ended by a fault, not by a person. Also a stop that lands while
    // this service is recovering the connection, whatever reason Zoom gives.
    const recovering = Boolean(session) && (session.reconnecting || session.state === 'waiting');
    const fault = isFaultStop(payload.stop_reason) || recovering;
    if (session) {
      release(session.streamId, session);
      log.log(`RTMS session stopped${fault ? ' by a fault' : ''}`);
    }
    const meetingEnded = payload.stop_reason === MEETING_ENDED;
    // A stop for a stream not held here is still passed on: the backend may
    // know the stream from before this process started
    await report(meetingUuid, session ? session.streamId : namedStreamId, 'rtms_stopped', {
      ...(fault && { fault: true }),
      ...(meetingEnded && { meetingEnded: true }),
    });
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
