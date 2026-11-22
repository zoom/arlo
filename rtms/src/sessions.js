/**
 * RTMS session lifecycle.
 *
 * One session per stream (keyed by rtms_stream_id). This module holds the
 * rules: when a stream counts as started, what happens when a join is refused,
 * how a stream ends, and what is forwarded to the backend. It never imports
 * the Zoom RTMS SDK: the client is injected, so the rules can be tested with a
 * fake client (the real one is a native module that only runs in the container).
 *
 * Nothing here is stored beyond the life of a stream.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ID_CHARS = 256;

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;

function createSessionManager({
  createClient,
  backend,
  logPii = false,
  log = console,
  now = Date.now,
  defer = setImmediate,
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

  /** Leave a stream we hold. `stopping` suppresses the SDK's teardown events. */
  function release(streamId, session) {
    session.stopping = true;
    sessions.delete(streamId);
    try {
      session.client.leave();
    } catch (error) {
      log.warn('Error leaving an RTMS session:', error.message);
    }
  }

  function onTranscript(session, data, timestamp, metadata) {
    const text = data.toString('utf-8');
    if (logPii) log.log('Raw transcript event:', { text, timestamp, metadata });

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

  /** meeting.rtms_started */
  async function started(payload) {
    const meetingUuid = payload?.meeting_uuid;
    const streamId = payload?.rtms_stream_id;
    if (!isId(meetingUuid) || !isId(streamId)) {
      log.warn('rtms_started ignored: missing meeting or stream id');
      return;
    }
    if (sessions.has(streamId)) {
      log.log('Already connected to this stream, ignoring duplicate webhook');
      return;
    }
    // A new stream id for a meeting we already hold replaces the old stream
    for (const [existingId, existing] of sessions) {
      if (existing.meetingUuid === meetingUuid) {
        log.log('New stream for a meeting already connected: replacing the old stream');
        release(existingId, existing);
      }
    }

    let client;
    try {
      client = createClient();
    } catch (error) {
      log.error('Could not create an RTMS client:', error.message);
      await send('status', backend.status(meetingUuid, 'rtms_failed'));
      return;
    }

    const session = {
      client,
      meetingUuid,
      streamId,
      stopping: false,
      firstTranscriptReceived: false,
      participantNames: new Map(),
      startedAt: now(),
      operatorId: isId(payload.operator_id) ? payload.operator_id : null,
      seqCounter: 0,
    };
    const isCurrent = () => sessions.get(streamId) === session;

    client.onTranscriptData((data, size, timestamp, metadata) => {
      try {
        onTranscript(session, data, timestamp, metadata);
      } catch (error) {
        log.error('Error processing transcript data:', error.message);
      }
    });

    // 0 = joined. Anything else is an RTMS_STATUS_CODE and no media will flow
    // (16 = STATUS_DUPLICATE_MEDIA_DATA_CONNECTION). "Started" is only reported here.
    client.onJoinConfirm((reason) => {
      if (reason === 0) {
        log.log('Joined RTMS session');
        send('status', backend.status(meetingUuid, 'rtms_started', session.operatorId || undefined));
        return;
      }
      log.error(`RTMS join refused by Zoom, status code ${reason}. See RTMS_STATUS_CODE in the Zoom RTMS docs.`);
      send('status', backend.status(meetingUuid, 'rtms_failed'));
      // Release outside the SDK callback so a new start is clean
      defer(() => { if (isCurrent()) release(streamId, session); });
    });

    // Zoom closed the connection. `reason` is an RTMS_STOP_REASON.
    client.onLeave((reason) => {
      log.log('RTMS connection closed, reason:', reason);
      if (session.stopping || !isCurrent()) return; // our own leave(), already handled
      sessions.delete(streamId);
      // Tell the meeting now instead of waiting for the stopped webhook
      send('status', backend.status(meetingUuid, 'rtms_stopped'));
    });

    client.onSessionUpdate((event) => {
      log.log('Session update:', event);
    });

    // Media dropped while signaling survives; the SDK reconnects media by itself
    client.onMediaConnectionInterrupted((timestamp) => {
      log.warn(`Media connection interrupted at ${timestamp}`);
      send('status', backend.status(meetingUuid, 'media_interrupted'));
    });

    client.onParticipantEvent((event, timestamp, participants) => {
      try {
        onParticipants(session, event, participants);
      } catch (error) {
        log.error('Error processing participant event:', error.message);
      }
    });

    // Stored before joining so a duplicate webhook during the join is ignored
    sessions.set(streamId, session);
    try {
      const result = client.join({
        meeting_uuid: meetingUuid,
        rtms_stream_id: streamId,
        server_urls: payload.server_urls,
      });
      log.log('Join result:', result);
    } catch (error) {
      log.error('Failed to start RTMS:', error.message);
      sessions.delete(streamId);
      await send('status', backend.status(meetingUuid, 'rtms_failed'));
    }
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
    if (found) {
      release(found.streamId, found.session);
      log.log('RTMS session stopped');
    }
    await send('status', backend.status(meetingUuid, 'rtms_stopped'));
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

  return { started, stopped, sweep, closeAll, size: () => sessions.size };
}

module.exports = { createSessionManager, SESSION_TTL_MS };
