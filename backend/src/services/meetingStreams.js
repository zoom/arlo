/**
 * The streams of each meeting, and the rule that stores each line once.
 *
 * Several Zoom users can each run a stream in one meeting at the same time:
 * each has its own stream id under the same meeting UUID and carries the same
 * speech. The server keeps one transcript per meeting. No stream is trusted
 * over another: a line from any stream of the meeting is stored, unless the
 * same line was stored a moment ago from another stream. Losing a line is
 * worse than storing one twice, so a line is only dropped when it is known to
 * be a copy.
 *
 * What a copy is. Per meeting, a short memory of the lines stored last (300
 * lines or 2 minutes, whichever is less) holds for each: the speaker id, a
 * hash of the text (the text is not held a second time), the line's start time
 * if it has one, when it arrived, and which streams have delivered it. A line
 * from stream S is a copy of a remembered line when
 *   - the speaker and the words are the same,
 *   - S has not delivered that remembered line already (the same words twice
 *     on one stream were said twice), and
 *   - they are close in time: start times within 5 seconds when both have
 *     one, otherwise arrivals within 10 seconds.
 * With several candidates the oldest is taken. A copy is dropped and S noted
 * on the remembered line; anything else is stored and remembered. So a stream
 * that is lines ahead or behind, stops, dies without a word or never delivers
 * loses nothing. A copy that arrives outside those windows is stored again.
 *
 * Participant events (people joining and leaving) arrive once per stream too
 * and are told apart the same way: same event type and participant (the id,
 * or the name when there is no id), from a stream that has not reported it
 * yet, within 10 seconds.
 *
 * One stream is the "primary" one: a live stream of the meeting's original
 * host, otherwise the live stream that started first. It decides nothing about
 * what is stored. It is the stream whose operator is named first (the owner
 * name the panels show) and whose connection trouble is the meeting's.
 *
 * This module also remembers who ran a stream in the meeting (operator ids),
 * including streams that have stopped, until forget(). The meeting lifecycle
 * calls forget() when it flushes the meeting, so nothing here outlives the
 * meeting's data. Ids and hashes only: no meeting content is held or logged.
 */
const crypto = require('node:crypto');

const MAX_ID_CHARS = 256;
const DEFAULTS = Object.freeze({
  maxStreamsPerMeeting: 20,
  maxMeetings: 5000,
  // The memory of stored lines used to tell a copy: this many, this long
  maxRecentLines: 300,
  recentLineMs: 2 * 60 * 1000,
  // Two deliveries of the same words by the same speaker are one line when
  // their start times are this close, or, without start times, their arrivals
  sameLineStampMs: 5 * 1000,
  sameLineArrivalMs: 10 * 1000,
  // The same for participant events, which are compared by arrival only
  maxRecentEvents: 1000,
  sameEventArrivalMs: 10 * 1000,
});
// A report without a stream id (an rtms process from before streams were
// told apart) is the only stream of its meeting: it gets this key.
const NO_STREAM_ID = '';

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isMissing = (value) => value === undefined || value === null;
/** The key a stream is kept under, or null when the id is not a sane one. */
const keyFor = (streamId) => {
  if (isMissing(streamId)) return NO_STREAM_ID;
  return isId(streamId) ? streamId : null;
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('base64');
/** An id as sent by the rtms service (a string; a number is taken as its digits). */
const idText = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.slice(0, MAX_ID_CHARS) : '';
};

/**
 * What identifies a transcript line across the streams that carry it: who
 * spoke and the words (as a hash), and the start time when it has one. Null
 * for something that is not a line: it is then never taken for a copy.
 */
function lineIdentity(line) {
  if (line === null || typeof line !== 'object' || typeof line.text !== 'string') return null;
  return {
    who: idText(line.speakerId),
    hash: sha256(line.text),
    stamp: Number.isFinite(line.tStartMs) ? line.tStartMs : null,
  };
}

/**
 * The same for a participant event: what happened and to whom (the id, or the
 * name when there is no id; hashed, so no name is held here). Null when the
 * event names nobody or nothing.
 */
function eventIdentity(event) {
  if (event === null || typeof event !== 'object') return null;
  const { eventType, participantId, participantName } = event;
  if (typeof eventType !== 'string' || eventType.length === 0) return null;
  const id = idText(participantId);
  const name = typeof participantName === 'string' ? participantName : '';
  if (id.length === 0 && name.length === 0) return null;
  return {
    who: '',
    hash: sha256(JSON.stringify([eventType.slice(0, MAX_ID_CHARS), id, id.length === 0 ? name : ''])),
    stamp: null,
  };
}

function createMeetingStreams(options = {}) {
  const { log = console, now = () => Date.now() } = options;
  const limits = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS)) {
    if (Number.isInteger(options[name]) && options[name] > 0) limits[name] = options[name];
  }
  const lineRules = {
    max: limits.maxRecentLines,
    keepMs: limits.recentLineMs,
    stampMs: limits.sameLineStampMs,
    arrivalMs: limits.sameLineArrivalMs,
  };
  const eventRules = {
    max: limits.maxRecentEvents,
    // An event older than the window can match nothing: it is not kept longer
    keepMs: limits.sameEventArrivalMs + 1,
    stampMs: 0,
    arrivalMs: limits.sameEventArrivalMs,
  };
  // meetingId -> {
  //   streams: Map(key -> { operatorId, originalHost, live, replaced }),
  //   primaryKey: the primary stream, or the last one when none is live,
  //   lines, events: what was stored last, oldest first, each
  //     { who, hash, stamp, at, from: Set(stream keys that delivered it) },
  //   warned }
  // The streams Map keeps the order in which the streams started. `replaced`
  // marks a stream that ended because its user started a new one.
  const meetings = new Map();

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (state) {
      // Move to the end: the Map's first key is then the meeting heard from longest ago
      meetings.delete(meetingId);
    } else {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= limits.maxMeetings) meetings.delete(meetings.keys().next().value);
      state = {
        streams: new Map(), primaryKey: null, lines: [], events: [], warned: false,
      };
    }
    meetings.set(meetingId, state);
    return state;
  }

  /**
   * The key of the stream a report is about, or null for an id that is not sane.
   * Reports with and without a stream id do not normally mix. When they do (an
   * older rtms process, or Zoom's own webhook naming a stream that was reported
   * without its id), the report is taken to be about the meeting's one stream:
   *   - a named stream not known here, when the stream known has no id, is that stream;
   *   - no id, when the streams known have ids: see holdsUnnamed().
   */
  function resolve(state, streamId) {
    const key = keyFor(streamId);
    if (key !== null && key !== NO_STREAM_ID && !state.streams.has(key) && state.streams.has(NO_STREAM_ID)) {
      return NO_STREAM_ID;
    }
    return key;
  }
  /** A report without an id, about a meeting whose streams are known by id. */
  const holdsUnnamed = (state, key) => key === NO_STREAM_ID && !state.streams.has(key) && state.streams.size > 0;

  const liveKeys = (state) => [...state.streams].filter(([, stream]) => stream.live).map(([key]) => key);

  /**
   * Work out the primary stream again after a stream started, stopped or was
   * learned. With nothing live, the last primary stream keeps the place, so
   * the owner named first does not change when the meeting's streams stop.
   */
  function choosePrimary(state) {
    const live = liveKeys(state);
    if (live.length === 0) return;
    state.primaryKey = live.find((key) => state.streams.get(key).originalHost) ?? live[0];
  }

  /** Add a stream to a meeting. Returns it, or null when the meeting is full. */
  function addStream(state, key) {
    if (state.streams.size >= limits.maxStreamsPerMeeting) {
      if (!state.warned) {
        state.warned = true;
        log.warn(`More than ${limits.maxStreamsPerMeeting} streams in one meeting: the rest are ignored`);
      }
      return null;
    }
    const stream = {
      operatorId: null, originalHost: false, live: true, replaced: false,
    };
    state.streams.set(key, stream);
    return stream;
  }

  /** A stream started, or reported itself running again after a rejoin. */
  function streamStarted(meetingId, { streamId, operatorId, originalHost } = {}) {
    if (!isId(meetingId) || keyFor(streamId) === null) return;
    const state = stateFor(meetingId);
    const key = resolve(state, streamId);
    // Which of the known streams it is cannot be told: nothing to add
    if (holdsUnnamed(state, key)) return;
    const operator = isId(operatorId) ? operatorId : null;

    // The same user started again: the rtms service has replaced their old
    // stream, so it is over here too, whether or not the stop report for it
    // has arrived. It is kept as a stopped stream, so a line of it still on
    // its way is not taken for a new stream; the one it had replaced itself
    // goes, so a user who keeps restarting does not fill the meeting.
    if (operator) {
      for (const [otherKey, other] of state.streams) {
        if (otherKey === key || other.operatorId !== operator) continue;
        if (other.replaced) {
          state.streams.delete(otherKey);
        } else {
          other.live = false;
          other.replaced = true;
        }
      }
    }

    let stream = state.streams.get(key);
    if (stream && !stream.live) {
      // Stopped and started again: it takes its place after the streams running now
      state.streams.delete(key);
      state.streams.set(key, stream);
    }
    if (!stream) stream = addStream(state, key);
    if (stream) {
      stream.live = true;
      stream.replaced = false;
      if (operator) stream.operatorId = operator;
      if (originalHost === true) stream.originalHost = true;
    }
    choosePrimary(state);
  }

  /**
   * A stream stopped or could not be joined. Without a stream id, every stream
   * of the meeting is taken as stopped. Returns whether any stream still runs.
   */
  function streamStopped(meetingId, streamId) {
    const state = meetings.get(meetingId);
    if (!state) return { anyLive: false };
    const key = resolve(state, streamId);
    if (key === NO_STREAM_ID && !state.streams.has(key)) {
      for (const stream of state.streams.values()) stream.live = false;
    } else if (key !== null && state.streams.has(key)) {
      state.streams.get(key).live = false;
    }
    choosePrimary(state);
    return { anyLive: liveKeys(state).length > 0 };
  }

  /**
   * The meeting itself ended: every stream of it is over, whichever stream the
   * report came on. Who ran the streams is kept until forget().
   */
  function stopAll(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    for (const stream of state.streams.values()) stream.live = false;
  }

  /**
   * Note that data arrived from a stream. Returns the meeting's state and the
   * key the stream's deliveries are noted under, or null when nothing from it
   * can be taken (an id that is not sane, or a meeting that is full).
   *
   * A stream first heard of through its data counts as started: this server
   * may have restarted mid-meeting and missed the report. The rtms service
   * says with every line and event whose stream it is (`operatorId`,
   * `originalHost`), so such a stream has its operator, and one known without
   * an operator gets it. Data never replaces another stream of the same user:
   * only a start report does. A stream known to have stopped is not brought
   * back by a late line, but the line is still looked at: it was on its way.
   */
  function heardFrom(meetingId, streamId, details) {
    if (!isId(meetingId) || keyFor(streamId) === null) return null;
    const state = stateFor(meetingId);
    const key = resolve(state, streamId);
    // One more stream, unnamed: its deliveries are noted under the empty key
    if (holdsUnnamed(state, key)) return { state, key };
    const stream = state.streams.get(key) ?? addStream(state, key);
    if (!stream) return null;
    if (stream.operatorId === null && isId(details?.operatorId)) stream.operatorId = details.operatorId;
    if (details?.originalHost === true) stream.originalHost = true;
    choosePrimary(state);
    return { state, key };
  }

  /**
   * Whether this delivery is the first of its line or event (true: store it)
   * or a copy of one stored a moment ago from another stream (false). The
   * rule is at the top of this file. `identity` null: cannot be a copy.
   */
  function firstDelivery(memory, identity, key, rules) {
    const at = now();
    while (memory.length > 0 && at - memory[0].at >= rules.keepMs) memory.shift();
    if (identity === null) return true;
    const copyOf = memory.find((seen) => {
      if (seen.hash !== identity.hash || seen.who !== identity.who || seen.from.has(key)) return false;
      return seen.stamp !== null && identity.stamp !== null
        ? Math.abs(seen.stamp - identity.stamp) <= rules.stampMs
        : at - seen.at <= rules.arrivalMs;
    });
    if (copyOf) {
      copyOf.from.add(key);
      return false;
    }
    memory.push({ ...identity, at, from: new Set([key]) });
    if (memory.length > rules.max) memory.shift();
    return true;
  }

  /**
   * A transcript line arrived from a stream: true when it is to be stored.
   * `details` is `{ line: { speakerId, tStartMs, text }, operatorId,
   * originalHost }`, each optional. Also notes the stream: see heardFrom().
   */
  function keepsLine(meetingId, streamId, details) {
    const heard = heardFrom(meetingId, streamId, details);
    return heard !== null && firstDelivery(heard.state.lines, lineIdentity(details?.line), heard.key, lineRules);
  }

  /**
   * The same for one participant event: `details` is `{ event: { eventType,
   * participantId, participantName }, operatorId, originalHost }`.
   */
  function keepsEvent(meetingId, streamId, details) {
    const heard = heardFrom(meetingId, streamId, details);
    return heard !== null && firstDelivery(heard.state.events, eventIdentity(details?.event), heard.key, eventRules);
  }

  /** True for the primary stream: see the top of this file. */
  function isPrimary(meetingId, streamId) {
    const state = meetings.get(meetingId);
    if (!state) return false;
    const key = resolve(state, streamId);
    if (key === null) return false;
    if (holdsUnnamed(state, key)) return true;
    return state.streams.has(key) && state.primaryKey === key;
  }

  /** Whether this stream is known and running. */
  function isLive(meetingId, streamId) {
    const state = meetings.get(meetingId);
    if (!state) return false;
    const key = resolve(state, streamId);
    return key !== null && state.streams.get(key)?.live === true;
  }

  const anyLive = (meetingId) => {
    const state = meetings.get(meetingId);
    return Boolean(state) && liveKeys(state).length > 0;
  };

  /** Operator ids of the streams seen in this meeting, the primary stream's first, each once. */
  function operators(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return [];
    const ordered = [state.streams.get(state.primaryKey), ...state.streams.values()]
      .map((stream) => stream?.operatorId)
      .filter(Boolean);
    return [...new Set(ordered)];
  }

  const primaryOperator = (meetingId) => {
    const state = meetings.get(meetingId);
    return state?.streams.get(state.primaryKey)?.operatorId ?? null;
  };

  /** How many lines and events are remembered for a meeting (null: meeting not known). */
  const remembered = (meetingId) => {
    const state = meetings.get(meetingId);
    return state ? { lines: state.lines.length, events: state.events.length } : null;
  };

  const forget = (meetingId) => meetings.delete(meetingId);

  return {
    streamStarted, streamStopped, stopAll, keepsLine, keepsEvent, isPrimary, isLive, anyLive,
    operators, primaryOperator, remembered, forget, size: () => meetings.size,
  };
}

let instance = null;

/** The record the running server uses. */
function getMeetingStreams() {
  if (!instance) instance = createMeetingStreams();
  return instance;
}

module.exports = { createMeetingStreams, getMeetingStreams };
