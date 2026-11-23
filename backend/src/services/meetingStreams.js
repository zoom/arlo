/**
 * The streams of each meeting, and which one the transcript is taken from.
 *
 * Several Zoom users can each run a stream in one meeting at the same time:
 * each has its own stream id under the same meeting UUID and carries the same
 * speech. The server keeps one transcript per meeting, so it stores the lines
 * of one stream, the source, and drops the others:
 *   - a live stream of the meeting's original host is the source; it can start
 *     before the host joins and keeps running after the host leaves,
 *   - otherwise the live stream that started first.
 * The source stays the source while it runs. It is chosen again when it stops
 * or when the original host's stream starts.
 *
 * A stream can also die without any stop report reaching this server. So the
 * source is watched through its lines: when a line arrives from another live
 * stream and the source has delivered nothing for 30 seconds, that other
 * stream becomes the source and its line is kept. Silence alone changes
 * nothing (nobody speaking is normal); only another stream's line can. A
 * stream that lost the role this way, the original host's included, gets it
 * back only by the same rule or by stopping and starting again.
 *
 * This module also remembers who ran a stream in the meeting (operator ids),
 * including streams that have stopped, until forget(). The meeting lifecycle
 * calls forget() when it flushes the meeting, so nothing here outlives the
 * meeting's data. Ids only: no meeting content is held or logged.
 */
const MAX_ID_CHARS = 256;
const DEFAULTS = Object.freeze({
  maxStreamsPerMeeting: 20,
  maxMeetings: 5000,
  // The source is taken to be dead when another stream delivers a line and the
  // source has delivered nothing for this long
  sourceSilentMs: 30 * 1000,
  // After such a switch, a line from the old source within this time shows it
  // was alive after all (see acceptsDataFrom): it gets the role back
  sourceRevertMs: 5 * 1000,
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

function createMeetingStreams(options = {}) {
  const { log = console, now = () => Date.now() } = options;
  const limits = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS)) {
    if (Number.isInteger(options[name]) && options[name] > 0) limits[name] = options[name];
  }
  // meetingId -> {
  //   streams: Map(key -> { operatorId, originalHost, live, demoted }),
  //   sourceKey,
  //   sourceHeardAt: when the source last delivered, or became the source,
  //   displaced: { key, at } the source replaced for silence a moment ago, or null,
  //   warned }
  // The streams Map keeps the order in which the streams started. `demoted`
  // marks a stream that lost the source role through silence.
  const meetings = new Map();

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (state) {
      // Move to the end: the Map's first key is then the meeting heard from longest ago
      meetings.delete(meetingId);
    } else {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= limits.maxMeetings) meetings.delete(meetings.keys().next().value);
      state = { streams: new Map(), sourceKey: null, sourceHeardAt: now(), displaced: null, warned: false };
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

  /** Make a stream the source. Its 30 seconds of silence are counted from now. */
  function setSource(state, key) {
    state.sourceKey = key;
    state.sourceHeardAt = now();
    state.displaced = null;
  }

  // The original host's stream is preferred, unless it lost the role through silence
  const preferred = (stream) => stream.originalHost && !stream.demoted;

  /** Keep the source while it runs; otherwise pick the next one. */
  function chooseSource(state) {
    const live = liveKeys(state);
    const hostKey = live.find((key) => preferred(state.streams.get(key)));
    const current = state.streams.get(state.sourceKey);
    if (current?.live && (preferred(current) || hostKey === undefined)) return;
    // Nothing live: the stream that was the source keeps that place, so its
    // last lines, still on their way, are kept
    if (live.length === 0 && current) return;
    // A stream that went silent is the last choice
    const next = hostKey ?? live.find((key) => !state.streams.get(key).demoted) ?? live[0] ?? null;
    if (next !== state.sourceKey) setSource(state, next);
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
    const stream = { operatorId: null, originalHost: false, live: true, demoted: false };
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
    // stream without a stop report, so it is replaced here too
    if (operator) {
      for (const [otherKey, other] of state.streams) {
        if (otherKey !== key && other.operatorId === operator) state.streams.delete(otherKey);
      }
    }

    let stream = state.streams.get(key);
    if (stream && !stream.live) {
      // Stopped and started again: it takes its place after the streams running now
      state.streams.delete(key);
      state.streams.set(key, stream);
      stream.demoted = false; // a new start: whatever silenced it before is over
    }
    if (!stream) stream = addStream(state, key);
    if (stream) {
      stream.live = true;
      if (operator) stream.operatorId = operator;
      if (originalHost === true) stream.originalHost = true;
    }
    chooseSource(state);
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
    chooseSource(state);
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
    state.displaced = null;
  }

  /** True for the one stream whose lines are stored. */
  function isSource(meetingId, streamId) {
    const state = meetings.get(meetingId);
    if (!state) return false;
    const key = resolve(state, streamId);
    if (key === null) return false;
    if (holdsUnnamed(state, key)) return true;
    return state.streams.has(key) && state.sourceKey === key;
  }

  /**
   * Whether a line or participant event from this stream is to be kept. Like
   * isSource(), except that a stream first heard of through its data counts as
   * started: this server may have restarted mid-meeting and missed the report.
   * A stream known to have stopped is not brought back by a late line.
   *
   * This is also where a dead source is noticed (see the top of this file): a
   * line from another live stream, when the source has delivered nothing for
   * `sourceSilentMs`, makes that stream the source.
   *
   * One case looks the same and is not a dead source. After a pause in the
   * talk every stream has been silent, and the first line of the next sentence
   * may arrive from another stream a moment before the source's own copy. The
   * other stream's line is kept (one copy is stored either way), and when the
   * old source's copy follows within `sourceRevertMs` it is dropped as the
   * duplicate it is and the old source has the role again.
   */
  function acceptsDataFrom(meetingId, streamId) {
    if (!isId(meetingId) || keyFor(streamId) === null) return false;
    const state = stateFor(meetingId);
    const key = resolve(state, streamId);
    if (holdsUnnamed(state, key)) {
      state.sourceHeardAt = now();
      return true;
    }
    if (!state.streams.has(key)) {
      addStream(state, key);
      chooseSource(state);
    }
    const stream = state.streams.get(key);
    if (!stream) return false; // the meeting is full
    const at = now();
    if (state.sourceKey === key) {
      state.sourceHeardAt = at;
      return true;
    }
    if (!stream.live) return false;

    const { displaced } = state;
    if (displaced && displaced.key === key && at - displaced.at < limits.sourceRevertMs) {
      stream.demoted = false;
      setSource(state, key);
      return false;
    }
    if (at - state.sourceHeardAt < limits.sourceSilentMs) return false;

    const silent = state.streams.get(state.sourceKey);
    const silentKey = state.sourceKey;
    if (silent) silent.demoted = true;
    stream.demoted = false;
    setSource(state, key);
    if (silent?.live) state.displaced = { key: silentKey, at };
    return true;
  }

  const anyLive = (meetingId) => {
    const state = meetings.get(meetingId);
    return Boolean(state) && liveKeys(state).length > 0;
  };

  /** Operator ids of the streams seen in this meeting, the source's first, each once. */
  function operators(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return [];
    const ordered = [state.streams.get(state.sourceKey), ...state.streams.values()]
      .map((stream) => stream?.operatorId)
      .filter(Boolean);
    return [...new Set(ordered)];
  }

  const sourceOperator = (meetingId) => {
    const state = meetings.get(meetingId);
    return state?.streams.get(state.sourceKey)?.operatorId ?? null;
  };

  const forget = (meetingId) => meetings.delete(meetingId);

  return {
    streamStarted, streamStopped, stopAll, isSource, acceptsDataFrom, anyLive,
    operators, sourceOperator, forget, size: () => meetings.size,
  };
}

let instance = null;

/** The record the running server uses. */
function getMeetingStreams() {
  if (!instance) instance = createMeetingStreams();
  return instance;
}

module.exports = { createMeetingStreams, getMeetingStreams };
