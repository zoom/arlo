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
 *     on one stream were said twice),
 *   - S was already known when the remembered line arrived: what a stream
 *     delivers cannot be a copy of something stored before that stream
 *     existed (a user's new stream after a restart, or a stream that starts
 *     after another stopped, carries what is said from then on). A second of
 *     grace: Zoom may deliver to a stream that just started a line whose copy
 *     from another stream arrived a moment earlier. And
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
 * yet and was already known when it was kept, within 10 seconds.
 *
 * One stream is the "primary" one: a live stream of the meeting's original
 * host, otherwise the live stream that started first. It decides nothing about
 * what is stored. It is the stream whose operator is named first (the owner
 * name the panels show) and whose connection trouble is the meeting's.
 *
 * Pause is per stream too: each user pauses their own. A stream is marked
 * paused by a report, and the meeting counts as paused only when at least one
 * stream runs and every running stream is paused. Two kinds of report:
 *   - the rtms service's, which is Zoom's own word from the stream's session
 *     (also for a pause made with Zoom's controls, not Arlo's). That mark is
 *     confirmed: only a resume report or the stream stopping removes it, not
 *     a line. After a rejoin it is no longer confirmed, because a resume
 *     during the gap would not have been heard.
 *   - a panel's, about its user's own stream. That mark also goes when a line
 *     arrives from the stream (it is running after all).
 * Both reports of one pause, in either order, are one mark.
 *
 * When the rtms service replaces a user's stream with their new one, and that
 * was the meeting's only stream, the stop is not the meeting's yet: the wait
 * for the new stream's outcome is held here (awaitReplacement), bounded by a
 * timer, and ends with the meeting.
 *
 * At most 20 streams run in one meeting. Streams that have stopped stay known
 * (their late lines, who ran them) but do not use up that room: when a stream
 * appears in a full meeting, the record of a stopped one goes (see makeRoom).
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
  // A line or event stored up to this long before a stream was first seen can
  // still be that stream's copy; anything stored earlier cannot
  startGraceMs: 1000,
  // Lines said just before a pause are still on their way when the pause is
  // reported: only a line this long after it shows the stream is running
  pauseSettleMs: 3 * 1000,
  // How long the outcome of a stream that replaces a user's old one is waited
  // for (Zoom keeps a stream it announced open for about a minute)
  replacementWaitMs: 90 * 1000,
});
// A report without a stream id (an rtms process from before streams were
// told apart) is the only stream of its meeting: it gets this key.
const NO_STREAM_ID = '';

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

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
  const { log = console, now = () => Date.now(), schedule = defaultSchedule } = options; // schedule: (fn, ms) => cancel
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
  //   streams: Map(key -> { operatorId, originalHost, live, replaced, pausedAt, pauseConfirmed, since, endedAt }),
  //   primaryKey: the primary stream, or the last one when none is live,
  //   lines, events: what was stored last, oldest first, each
  //     { who, hash, stamp, at, from: Set(stream keys that delivered it) },
  //   awaiting: { cancel } while a replacing stream's outcome is waited for,
  //   pauseKept: whether the stored timeline's last word is "paused" (see pauseKept()),
  //   warned }
  // The streams Map keeps the order in which the streams started. `replaced`
  // marks a stream that ended because its user started a new one, `pausedAt`
  // is when a running stream was reported paused (null: not paused),
  // `pauseConfirmed` whether Zoom itself said so (the rtms service), `since`
  // is when the stream was first seen or last started, `endedAt` when it
  // stopped (null while it runs).
  const meetings = new Map();

  /** End the wait for a replacing stream, if there is one. Returns whether there was. */
  function endWait(state) {
    if (!state?.awaiting) return false;
    const { cancel } = state.awaiting;
    state.awaiting = null;
    if (typeof cancel === 'function') cancel();
    return true;
  }

  /** Drop everything held for a meeting, its timer included. */
  function drop(meetingId) {
    endWait(meetings.get(meetingId));
    return meetings.delete(meetingId);
  }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (state) {
      // Move to the end: the Map's first key is then the meeting heard from longest ago
      meetings.delete(meetingId);
    } else {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= limits.maxMeetings) drop(meetings.keys().next().value);
      state = {
        streams: new Map(), primaryKey: null, lines: [], events: [], awaiting: null, pauseKept: false, warned: false,
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
  /** A stream is over: it no longer runs, so it is no longer paused either. */
  const end = (stream) => {
    if (stream.live) stream.endedAt = now();
    stream.live = false;
    stream.pausedAt = null;
    stream.pauseConfirmed = false;
  };
  /** With nothing running, nothing is paused: the next start is a running stream. */
  const noteNothingRuns = (state) => {
    if (liveKeys(state).length === 0) state.pauseKept = false;
  };

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

  /**
   * Make room in a full meeting by dropping the record of one stopped stream.
   * Returns false when every stream known is running.
   *
   * Who brought Arlo in is read from these records (operators()), so a stopped
   * stream whose operator is not known or has another stream here goes first:
   * nobody stops being an owner for it. Otherwise the stream that stopped
   * longest ago goes, and its operator is no longer listed as an owner. That
   * only happens past the limit (20 stream records in one meeting, each of a
   * different user) and is accepted there. A line of the dropped stream that
   * is still on its way would be taken for a new stream's: the one that
   * stopped longest ago is the least likely to have any.
   */
  function makeRoom(state) {
    const stopped = [...state.streams].filter(([, stream]) => !stream.live);
    if (stopped.length === 0) return false;
    const spare = stopped.filter(([key, stream]) => stream.operatorId === null
      || [...state.streams].some(([otherKey, other]) => otherKey !== key && other.operatorId === stream.operatorId));
    const [oldest] = (spare.length > 0 ? spare : stopped).sort((a, b) => a[1].endedAt - b[1].endedAt);
    state.streams.delete(oldest[0]);
    return true;
  }

  /**
   * Add a stream to a meeting. Returns it, or null when the meeting is full:
   * the limit is on streams that run, so a stopped one makes room first.
   */
  function addStream(state, key) {
    if (state.streams.size >= limits.maxStreamsPerMeeting && !makeRoom(state)) {
      if (!state.warned) {
        state.warned = true;
        // No id of any kind: the count says all there is to say
        log.warn(`${limits.maxStreamsPerMeeting} streams are running in one meeting: more are ignored`);
      }
      return null;
    }
    const stream = {
      operatorId: null,
      originalHost: false,
      live: true,
      replaced: false,
      pausedAt: null,
      pauseConfirmed: false,
      since: now(),
      endedAt: null,
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
          end(other);
          other.replaced = true;
        }
      }
    }

    let stream = state.streams.get(key);
    if (stream && !stream.live) {
      // Stopped and started again: it takes its place after the streams running
      // now, and carries what is said from now on (see `since`)
      state.streams.delete(key);
      state.streams.set(key, stream);
      stream.since = now();
      stream.endedAt = null;
    }
    // A stream that reports itself running again after a rejoin keeps its
    // pause mark, but no longer as Zoom's confirmed word (a resume during the
    // gap was not heard): if it is in fact running, its next line says so
    if (stream) stream.pauseConfirmed = false;
    else stream = addStream(state, key);
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
      for (const stream of state.streams.values()) end(stream);
    } else if (key !== null && state.streams.has(key)) {
      end(state.streams.get(key));
    }
    choosePrimary(state);
    noteNothingRuns(state);
    return { anyLive: liveKeys(state).length > 0 };
  }

  /**
   * The meeting itself ended: every stream of it is over, whichever stream the
   * report came on. Who ran the streams is kept until forget().
   */
  function stopAll(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    for (const stream of state.streams.values()) end(stream);
    noteNothingRuns(state);
    endWait(state);
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
    return { state, key, stream };
  }

  /**
   * Whether this delivery is the first of its line or event (true: store it)
   * or a copy of one stored a moment ago from another stream (false). The
   * rule is at the top of this file. `identity` null: cannot be a copy.
   * `heard` is heardFrom()'s answer: the memory is `heard.state[kind]`, and
   * the stream (none for an unnamed one more stream: nothing is known about
   * when it started, so nothing stored is too old to be its copy).
   */
  function firstDelivery(heard, kind, identity, rules) {
    const memory = heard.state[kind];
    const { key } = heard;
    const at = now();
    while (memory.length > 0 && at - memory[0].at >= rules.keepMs) memory.shift();
    if (identity === null) return true;
    // What was stored before the stream existed is not something it copies
    const knownFrom = heard.stream ? heard.stream.since - limits.startGraceMs : -Infinity;
    const copyOf = memory.find((seen) => {
      if (seen.hash !== identity.hash || seen.who !== identity.who || seen.from.has(key)) return false;
      if (seen.at < knownFrom) return false;
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
    if (heard === null) return false;
    // A line, also a copy, shows that a stream marked paused is running,
    // unless Zoom itself said it is paused: then only a resume report counts
    const { pausedAt = null, pauseConfirmed = false } = heard.stream ?? {};
    if (pausedAt !== null && !pauseConfirmed && now() - pausedAt >= limits.pauseSettleMs) heard.stream.pausedAt = null;
    return firstDelivery(heard, 'lines', lineIdentity(details?.line), lineRules);
  }

  /**
   * The same for one participant event: `details` is `{ event: { eventType,
   * participantId, participantName }, operatorId, originalHost }`.
   */
  function keepsEvent(meetingId, streamId, details) {
    const heard = heardFrom(meetingId, streamId, details);
    return heard !== null && firstDelivery(heard, 'events', eventIdentity(details?.event), eventRules);
  }

  /**
   * Mark a running stream paused or resumed. `who` names it: `{ operatorId }`
   * is the running stream of that user, `{ streamId }` that stream (without an
   * id: the meeting's one unnamed stream). `confirmed: true` for Zoom's own
   * word (the rtms service's report), which a line does not undo; a pause
   * already confirmed stays so when a panel reports it too.
   * Returns whether a stream was marked.
   */
  function setPaused(meetingId, who, paused, { confirmed = false } = {}) {
    const state = meetings.get(meetingId);
    if (!state || who === null || typeof who !== 'object') return false;
    let marked = [];
    if (!isMissing(who.operatorId)) {
      if (isId(who.operatorId)) marked = [...state.streams.values()].filter((stream) => stream.operatorId === who.operatorId);
    } else {
      const stream = state.streams.get(resolve(state, who.streamId));
      if (stream) marked = [stream];
    }
    marked = marked.filter((stream) => stream.live);
    for (const stream of marked) {
      if (paused !== true) {
        stream.pausedAt = null;
        stream.pauseConfirmed = false;
      } else if (stream.pausedAt === null || !stream.pauseConfirmed) {
        // A second report of a pause Zoom confirmed changes nothing about it
        stream.pausedAt = now();
        stream.pauseConfirmed = confirmed === true;
      }
    }
    return marked.length > 0;
  }

  /**
   * What is paused: `meeting` (at least one stream runs and every running one
   * is paused), how many `streams`, and their `operators` (each once).
   */
  function pauseState(meetingId) {
    const live = [...(meetings.get(meetingId)?.streams.values() ?? [])].filter((stream) => stream.live);
    const paused = live.filter((stream) => stream.pausedAt !== null);
    return {
      meeting: live.length > 0 && paused.length === live.length,
      streams: paused.length,
      operators: [...new Set(paused.map((stream) => stream.operatorId).filter(Boolean))],
    };
  }

  /**
   * Whether the meeting's stored timeline says "paused" last. A pause a panel
   * reports is shown but not kept (a browser's word is not stored); when the
   * rtms service then confirms it, the meeting does not change again, and
   * this tells the caller that the line is still to be kept. Without an
   * argument it is read; with one it is set. False again when nothing runs.
   */
  function pauseKept(meetingId, kept) {
    const state = meetings.get(meetingId);
    if (!state) return false;
    if (typeof kept === 'boolean') state.pauseKept = kept;
    return state.pauseKept;
  }

  /** Operator ids of the streams running now, each once. */
  function liveOperators(meetingId) {
    const live = [...(meetings.get(meetingId)?.streams.values() ?? [])].filter((stream) => stream.live);
    return [...new Set(live.map((stream) => stream.operatorId).filter(Boolean))];
  }

  /**
   * Wait for the outcome of the stream that replaces a user's old one. The
   * caller settles the wait when the outcome is known (settleReplacement);
   * `onTimeout` is called once if it is not settled within `replacementWaitMs`.
   * Asked again while waiting, the first wait goes on. The wait ends without a
   * call when the meeting is forgotten or ends.
   */
  function awaitReplacement(meetingId, onTimeout) {
    const state = meetings.get(meetingId);
    if (!state || state.awaiting || typeof onTimeout !== 'function') return;
    const wait = { cancel: null };
    state.awaiting = wait;
    wait.cancel = schedule(() => {
      // Not this wait any more (settled, or the meeting went): nothing to say
      if (meetings.get(meetingId) !== state || state.awaiting !== wait) return;
      state.awaiting = null;
      onTimeout();
    }, limits.replacementWaitMs);
  }

  /** The outcome is known: end the wait. Returns whether there was one. */
  const settleReplacement = (meetingId) => endWait(meetings.get(meetingId));

  const awaitingReplacement = (meetingId) => Boolean(meetings.get(meetingId)?.awaiting);

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

  /** Whether this stream is known and no longer running. */
  function hasStopped(meetingId, streamId) {
    const state = meetings.get(meetingId);
    if (!state) return false;
    const key = resolve(state, streamId);
    return key !== null && state.streams.get(key)?.live === false;
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

  const forget = (meetingId) => drop(meetingId);

  return {
    streamStarted, streamStopped, stopAll, keepsLine, keepsEvent,
    setPaused, pauseState, pauseKept, awaitReplacement, settleReplacement, awaitingReplacement,
    isPrimary, isLive, hasStopped, anyLive, operators, liveOperators, primaryOperator,
    remembered, forget, size: () => meetings.size,
  };
}

let instance = null;

/** The record the running server uses. */
function getMeetingStreams() {
  if (!instance) instance = createMeetingStreams();
  return instance;
}

module.exports = { createMeetingStreams, getMeetingStreams };
