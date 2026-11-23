/**
 * Decides when a meeting's in-memory data is deleted.
 *
 * Inside one meeting nothing is flushed: a stop, pause, reconnect or restart
 * keeps the data, and a restarted stream continues it. The data goes when the
 * meeting ends:
 *   - Zoom reports the stream stopped because the meeting ended, or
 *   - the stream is not running and no Arlo panel is connected for the
 *     grace period (a panel knows the meeting is still going; none left
 *     means nobody is there to read the data), or
 *   - the store's age limit passes (sweep), in case no signal ever arrives.
 *
 * Per meeting this module knows three things: whether the stream is running
 * (told by the rtms service, or implied by a transcript line arriving when
 * nothing was told, e.g. after this server restarted mid-meeting), how many
 * panels are connected, and whether the meeting was flushed a moment ago (so a
 * line still in flight is not kept). It never reads or logs meeting content.
 */
const config = require('../config');
const { getMeetingStore } = require('../storage');

const MAX_ID_CHARS = 256;
const isMeetingId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;

const RUNNING = new Set(['rtms_started', 'rtms_reconnected']);
const NOT_RUNNING = new Set(['rtms_stopped', 'rtms_failed']);
// After a flush, lines for that meeting are refused for this long
const FLUSHED_MEMORY_MS = 10 * 60 * 1000;
const MAX_FLUSHED_REMEMBERED = 5000;

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

function createMeetingLifecycle({
  store,
  schedule = defaultSchedule,
  graceMs = 2 * 60 * 1000,
  onFlush = () => {},
  now = Date.now,
}) {
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 2 * 60 * 1000;
  // running: true | false as told by the rtms service, null = never told
  const meetings = new Map(); // meetingId -> { running, panels, cancel }
  const flushedAt = new Map(); // meetingId -> when it was flushed

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      state = { running: null, panels: 0, cancel: null };
      meetings.set(meetingId, state);
    }
    return state;
  }

  function rememberFlushed(meetingId) {
    flushedAt.delete(meetingId);
    if (flushedAt.size >= MAX_FLUSHED_REMEMBERED) flushedAt.delete(flushedAt.keys().next().value);
    flushedAt.set(meetingId, now());
  }

  function wasJustFlushed(meetingId) {
    const at = flushedAt.get(meetingId);
    if (at === undefined) return false;
    if (now() - at > FLUSHED_MEMORY_MS) {
      flushedAt.delete(meetingId);
      return false;
    }
    return true;
  }

  function flush(meetingId, reason) {
    const state = meetings.get(meetingId);
    if (state?.cancel) {
      state.cancel();
      state.cancel = null;
    }
    // Panels that are still connected stay counted: the WebSocket server only
    // reports changes, so forgetting them here would make a later stop look idle.
    if (state && state.panels > 0) state.running = false;
    else meetings.delete(meetingId);
    const hadData = store.deleteMeeting(meetingId);
    // Lines still in flight are refused for a while, but only when there was
    // something to flush or the meeting is over. An idle flush of nothing (a
    // panel opened and closed before anyone spoke) must not silence a stream
    // that is in fact live.
    if (hadData || reason === 'meeting_ended') rememberFlushed(meetingId);
    try {
      onFlush(reason, hadData);
    } catch {
      // Reporting a flush must never undo it or crash a timer
    }
  }

  function reconsider(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    const idle = state.running !== true && state.panels === 0;
    if (idle && !state.cancel) {
      state.cancel = schedule(() => {
        state.cancel = null;
        if (meetings.get(meetingId) === state) flush(meetingId, 'idle');
      }, grace);
    } else if (!idle && state.cancel) {
      state.cancel();
      state.cancel = null;
    }
  }

  /** A stream status from the rtms service. `meetingEnded` = Zoom said the meeting is over. */
  function streamStatus(meetingId, status, { meetingEnded = false } = {}) {
    if (!isMeetingId(meetingId)) return;
    if (meetingEnded === true && status === 'rtms_stopped') {
      flush(meetingId, 'meeting_ended');
      return;
    }
    if (RUNNING.has(status)) {
      flushedAt.delete(meetingId); // a real stream again: its lines are wanted
      stateFor(meetingId).running = true;
    } else if (NOT_RUNNING.has(status)) {
      stateFor(meetingId).running = false;
    } else if (!meetings.has(meetingId)) {
      return; // pause, interruption or an unknown word about a meeting not tracked: nothing to do
    }
    reconsider(meetingId);
  }

  /** How many Arlo panels are connected for this meeting right now. */
  function panelsChanged(meetingId, count) {
    if (!isMeetingId(meetingId) || !Number.isInteger(count) || count < 0) return;
    if (count === 0 && !meetings.has(meetingId) && !store.has(meetingId)) return;
    stateFor(meetingId).panels = count;
    reconsider(meetingId);
  }

  /**
   * A transcript line or timeline event is about to be kept. Returns false when
   * it must not be: the meeting was flushed a moment ago, so this is a line
   * that was still in flight. Otherwise the meeting is tracked from here on, so
   * data can never sit in the store without something deciding when it goes.
   */
  function dataReceived(meetingId) {
    if (!isMeetingId(meetingId)) return false;
    if (wasJustFlushed(meetingId)) return false;
    const state = stateFor(meetingId);
    // Lines are arriving and nobody said the stream stopped: it is running.
    // (This server may have restarted mid-meeting and missed "started".)
    if (state.running === null) state.running = true;
    reconsider(meetingId);
    return true;
  }

  /** Age-limit backstop and housekeeping. Returns how many meetings the store deleted. */
  function sweep() {
    const deleted = store.sweep();
    for (const [meetingId, state] of meetings) {
      // Nothing held and nobody connected: nothing left to decide about
      if (state.panels === 0 && !store.has(meetingId)) {
        if (state.cancel) state.cancel();
        meetings.delete(meetingId);
      }
    }
    for (const [meetingId, at] of flushedAt) {
      if (now() - at > FLUSHED_MEMORY_MS) flushedAt.delete(meetingId);
    }
    return deleted;
  }

  return { streamStatus, panelsChanged, dataReceived, sweep, tracked: () => meetings.size };
}

let instance = null;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** The lifecycle the running server uses. */
function getMeetingLifecycle() {
  if (!instance) {
    instance = createMeetingLifecycle({
      store: getMeetingStore(),
      graceMs: config.meetingFlushGraceMs,
      // Reason and whether anything was held: never a meeting id
      onFlush: (reason, hadData) => console.log(`Meeting data flushed (${reason}${hadData ? '' : ', nothing held'})`),
    });
    setInterval(() => {
      const deleted = instance.sweep();
      if (deleted > 0) console.log(`Meeting data sweep: ${deleted} meeting(s) past the age limit removed`);
    }, SWEEP_INTERVAL_MS).unref();
  }
  return instance;
}

module.exports = { createMeetingLifecycle, getMeetingLifecycle };
