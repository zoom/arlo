/**
 * Decides when a meeting's in-memory data is deleted.
 *
 * Inside one meeting nothing is flushed: a stop, pause, reconnect or restart
 * keeps the data, and a restarted stream continues it. The data goes when the
 * meeting ends:
 *   - Zoom reports a stream stopped because the meeting ended, or
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
const { getMeetingStreams } = require('./meetingStreams');

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
  // Called with the meeting id when a meeting is flushed or no longer tracked,
  // so state kept elsewhere per meeting goes at the same moment
  onForget = () => {},
  now = Date.now,
}) {
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 2 * 60 * 1000;
  // running: true | false as told by the rtms service, null = never told
  const meetings = new Map(); // meetingId -> { running, panels, cancel }
  const flushedAt = new Map(); // meetingId -> { at: when it was flushed, ended: because the meeting ended }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      state = { running: null, panels: 0, cancel: null };
      meetings.set(meetingId, state);
    }
    return state;
  }

  function rememberFlushed(meetingId, reason) {
    const ended = reason === 'meeting_ended' || flushedAt.get(meetingId)?.ended === true;
    flushedAt.delete(meetingId);
    if (flushedAt.size >= MAX_FLUSHED_REMEMBERED) flushedAt.delete(flushedAt.keys().next().value);
    flushedAt.set(meetingId, { at: now(), ended });
  }

  /** The record of a flush a moment ago, or null. */
  function recentFlush(meetingId) {
    const flushed = flushedAt.get(meetingId);
    if (flushed === undefined) return null;
    if (now() - flushed.at > FLUSHED_MEMORY_MS) {
      flushedAt.delete(meetingId);
      return null;
    }
    return flushed;
  }

  const wasJustFlushed = (meetingId) => recentFlush(meetingId) !== null;

  /**
   * Whether Zoom said a moment ago that this meeting is over. A meeting with
   * several streams gets a stop report per stream; after the first one that
   * says "the meeting ended", the rest are about a meeting that is already
   * gone. So is a start or rejoin report: a Zoom meeting UUID that ended does
   * not start again, so nothing brings the meeting back while this is true.
   */
  const hasEnded = (meetingId) => recentFlush(meetingId)?.ended === true;

  function forget(meetingId) {
    try {
      onForget(meetingId);
    } catch {
      // A listener must never undo a flush or crash a timer
    }
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
    if (hadData || reason === 'meeting_ended') rememberFlushed(meetingId, reason);
    forget(meetingId);
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
      if (hasEnded(meetingId)) return; // the meeting is over: this report was still on its way
      flushedAt.delete(meetingId); // a real stream again after an idle flush: its lines are wanted
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
    // Told "stopped", yet a line arrives: a late line, or a restart whose
    // "started" report was lost. Either way the meeting is not idle yet, so
    // the wait before an idle flush starts over from this line.
    if (state.cancel) {
      state.cancel();
      state.cancel = null;
    }
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
        forget(meetingId);
      }
    }
    for (const [meetingId, flushed] of flushedAt) {
      if (now() - flushed.at > FLUSHED_MEMORY_MS) flushedAt.delete(meetingId);
    }
    return deleted;
  }

  return {
    streamStatus, panelsChanged, dataReceived, hasEnded, sweep, tracked: () => meetings.size,
  };
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
      // What is known about the meeting's streams (who ran one) and the notes
      // engine's state for it go with its data
      onForget: (meetingId) => {
        getMeetingStreams().forget(meetingId);
        // Required here: the notes engine's neighbours require this module
        // eslint-disable-next-line global-require
        require('./notesEngine').getNotesEngine().forget(meetingId);
      },
    });
    setInterval(() => {
      const deleted = instance.sweep();
      if (deleted > 0) console.log(`Meeting data sweep: ${deleted} meeting(s) past the age limit removed`);
    }, SWEEP_INTERVAL_MS).unref();
  }
  return instance;
}

module.exports = { createMeetingLifecycle, getMeetingLifecycle };
