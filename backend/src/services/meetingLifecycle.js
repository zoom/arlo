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
 * This module only knows two facts per meeting: is the stream running, and
 * how many panels are connected. It never reads or logs meeting content.
 */
const config = require('../config');
const { getMeetingStore } = require('../storage');

const MAX_ID_CHARS = 256;
const isMeetingId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;

const RUNNING = new Set(['rtms_started', 'rtms_reconnected']);
const NOT_RUNNING = new Set(['rtms_stopped', 'rtms_failed']);

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
}) {
  const meetings = new Map(); // meetingId -> { running, panels, cancel }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      state = { running: false, panels: 0, cancel: null };
      meetings.set(meetingId, state);
    }
    return state;
  }

  function flush(meetingId, reason) {
    const state = meetings.get(meetingId);
    if (state?.cancel) state.cancel();
    meetings.delete(meetingId);
    const hadData = store.deleteMeeting(meetingId);
    onFlush(reason, hadData);
  }

  function reconsider(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    const idle = !state.running && state.panels === 0;
    if (idle && !state.cancel) {
      state.cancel = schedule(() => {
        state.cancel = null;
        if (meetings.get(meetingId) === state) flush(meetingId, 'idle');
      }, graceMs);
    } else if (!idle && state.cancel) {
      state.cancel();
      state.cancel = null;
    }
  }

  /** A stream status from the rtms service. `meetingEnded` = Zoom said the meeting is over. */
  function streamStatus(meetingId, status, { meetingEnded = false } = {}) {
    if (!isMeetingId(meetingId)) return;
    if (meetingEnded === true) {
      flush(meetingId, 'meeting_ended');
      return;
    }
    const state = stateFor(meetingId);
    if (RUNNING.has(status)) state.running = true;
    else if (NOT_RUNNING.has(status)) state.running = false;
    reconsider(meetingId);
  }

  /** How many Arlo panels are connected for this meeting right now. */
  function panelsChanged(meetingId, count) {
    if (!isMeetingId(meetingId) || !Number.isInteger(count) || count < 0) return;
    if (count === 0 && !meetings.has(meetingId) && !store.has(meetingId)) return;
    stateFor(meetingId).panels = count;
    reconsider(meetingId);
  }

  /** Age-limit backstop. Returns how many meetings the store deleted. */
  function sweep() {
    const deleted = store.sweep();
    for (const [meetingId, state] of meetings) {
      if (!state.running && state.panels === 0 && !state.cancel && !store.has(meetingId)) {
        meetings.delete(meetingId);
      }
    }
    return deleted;
  }

  return { streamStatus, panelsChanged, sweep, tracked: () => meetings.size };
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
