/**
 * Writes a meeting's live notes from its stored transcript, on a timer, for
 * the people who may see them: those who brought Arlo in (the meeting's owners,
 * services/arloPresence.js) and, while an owner shares the notes, everyone in
 * the meeting who has Arlo open.
 *
 * The notes are one document per meeting, kept in the meeting store with the
 * transcript and deleted with it. Each run gives the model the notes so far
 * and the lines stored since, and replaces the notes with its answer:
 *   - nothing runs for a meeting without an owner, or while no panel that may
 *     see the notes is open in it (an owner's, or anyone's while the notes are
 *     shared): nobody would see them. The lines wait, and a run follows when
 *     such a panel connects or the notes become shared;
 *   - the first run happens when `firstRunSegments` lines are stored, or one
 *     interval after the first line, whichever is first;
 *   - after that at most one run per interval, and only when there are new lines;
 *   - one run at a time per meeting; lines stored during a run wait for the next;
 *   - a failed run keeps the old notes and is tried again after the interval
 *     (after two minutes when the models are rate limited). After five failed
 *     runs in a row nothing more is tried until a new line is stored; the
 *     count then starts over.
 *
 * The model's answer is untrusted input. It is rebuilt here from the known
 * fields (validNotes) and bounded again by the store before anything is kept
 * or sent.
 *
 * Per meeting this module holds counters and a timer, no content. That state
 * goes when the meeting's data goes: forget() is called by the meeting
 * lifecycle at a flush, and every timer tick checks that the store still holds
 * the meeting. Never log transcript text, notes or names from here: log lines
 * carry an error code at most.
 */
const { newestLines } = require('../lib/transcriptLines');

const MAX_ID_CHARS = 256;
const RATE_LIMIT_WAIT_MS = 2 * 60 * 1000;
// More than the store keeps (20 decisions, 30 action items); the store cuts the rest
const MAX_LIST_ENTRIES = 100;
const DEFAULT_INTERVAL_MS = 45000;
const MAX_FAILED_RUNS = 5;
// What models write in an owner field when nobody was named
const NOBODY = new Set(['null', 'none', 'n/a', 'unknown']);

const isMeetingId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
/** An own property that is a string with something in it, trimmed; otherwise null. */
const textOf = (object, key) => {
  if (!hasOwn(object, key) || typeof object[key] !== 'string') return null;
  const trimmed = object[key].trim();
  return trimmed.length > 0 ? trimmed : null;
};
/** An action item's owner: a name, or null also when the model wrote a word for "nobody". */
const ownerOf = (item) => {
  const owner = textOf(item, 'owner');
  return owner === null || NOBODY.has(owner.toLowerCase()) ? null : owner;
};
const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The model's answer as notes, or null when it is not usable. Only the known
 * fields are read, and only entries of the right shape are kept. An answer
 * that says nothing (no summary, no decisions, no action items) is not notes.
 */
function validNotes(answer) {
  if (!isPlainObject(answer) || !hasOwn(answer, 'summary') || typeof answer.summary !== 'string') return null;
  const list = (key) => (hasOwn(answer, key) && Array.isArray(answer[key]) ? answer[key].slice(0, MAX_LIST_ENTRIES) : []);
  const decisions = list('decisions')
    .filter((line) => typeof line === 'string')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const actionItems = list('actionItems')
    .filter((item) => isPlainObject(item) && textOf(item, 'text') !== null)
    .map((item) => ({ text: textOf(item, 'text'), owner: ownerOf(item) }));
  const summary = answer.summary.trim();
  if (summary.length === 0 && decisions.length === 0 && actionItems.length === 0) return null;
  return { summary, decisions, actionItems };
}

function createNotesEngine({
  store,
  generate,
  presence,
  send = () => {},
  // (meetingId, ownerUserIds) => whether a panel that may see the notes is
  // open in that meeting: one of theirs, or anyone's while the notes are
  // shared. Injected: this module knows nothing about sockets or sharing.
  hasOwnerPanel = () => true,
  schedule = defaultSchedule,
  now = () => Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
  firstRunSegments = 5,
  maxInputChars = 12000,
  maxMeetings = 5000,
  enabled = true,
  log = console,
}) {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  // meetingId -> {
  //   waiting: lines stored since the last run started (a count, not the lines),
  //   dueAt: the earliest time of the next run,
  //   attempted: a run was tried, so the "five lines" start no longer applies,
  //   running: a run is in progress,
  //   failures: failed runs in a row,
  //   cancel: cancels the timer, or null }
  const meetings = new Map();

  function forget(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    if (state.cancel) state.cancel();
    state.cancel = null;
    meetings.delete(meetingId);
  }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= maxMeetings) forget(meetings.keys().next().value);
      state = {
        waiting: 0, dueAt: now() + interval, attempted: false, running: false, failures: 0, cancel: null,
      };
      meetings.set(meetingId, state);
    }
    return state;
  }

  /** Arlo user ids of the meeting's owners. A lookup that fails finds nobody. */
  function ownersOf(meetingId) {
    try {
      const ids = presence.ownerUserIds(meetingId);
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  /** Whether a panel that may see the notes is open in the meeting. A lookup that fails finds none. */
  function panelOpen(meetingId, ownerUserIds) {
    try {
      return hasOwnerPanel(meetingId, ownerUserIds) === true;
    } catch {
      return false;
    }
  }

  /** Whether notes written now would have a reader: a panel open that may see them. */
  function hasReader(meetingId) {
    const owners = ownersOf(meetingId);
    return owners.length > 0 && panelOpen(meetingId, owners);
  }

  /** The lines after `throughSeqNo` as "<speaker>: <text>", newest kept within the size limit. */
  function inputFor(meetingId, throughSeqNo) {
    const segments = store.listSegments(meetingId).filter((segment) => segment.seqNo > throughSeqNo);
    const { lines } = newestLines(segments, maxInputChars);
    return { lines, through: segments.length > 0 ? segments[segments.length - 1].seqNo : throughSeqNo };
  }

  function arm(meetingId, state, delayMs) {
    if (state.cancel) return;
    state.cancel = schedule(() => {
      state.cancel = null;
      // eslint-disable-next-line no-use-before-define
      if (meetings.get(meetingId) === state) consider(meetingId);
    }, Math.max(delayMs, 1));
  }

  /**
   * Write the notes again now, whatever the timer says. Resolves true when new
   * notes were stored. Used by the timer and by tests.
   */
  async function runNow(meetingId) {
    if (!enabled || !isMeetingId(meetingId)) return false;
    if (!store.has(meetingId)) {
      forget(meetingId);
      return false;
    }
    const state = stateFor(meetingId);
    if (state.running || !hasReader(meetingId)) return false;

    const previous = store.getNotes(meetingId);
    const { lines, through } = inputFor(meetingId, previous ? previous.throughSeqNo : 0);
    if (lines.length === 0) {
      state.waiting = 0;
      return false;
    }

    const taken = state.waiting;
    state.waiting = 0;
    state.running = true;
    state.attempted = true;
    if (state.cancel) {
      state.cancel();
      state.cancel = null;
    }
    let wait = interval;
    let stored = null;
    try {
      const answer = await generate({
        previous: previous
          ? { summary: previous.summary, decisions: previous.decisions, actionItems: previous.actionItems }
          : null,
        lines,
      });
      const notes = validNotes(answer);
      if (!notes) throw Object.assign(new Error('not notes'), { code: 'bad_answer' });
      // Flushed while the model worked (and perhaps running again under the
      // same id): this answer is about a meeting whose data is gone
      if (meetings.get(meetingId) !== state) return false;
      stored = store.setNotes(meetingId, { ...notes, throughSeqNo: through });
      if (!stored) {
        forget(meetingId);
        return false;
      }
      state.failures = 0;
    } catch (error) {
      // The lines of this run are still to be written up
      state.waiting += taken;
      state.failures += 1;
      if (error && error.code === 'rate_limited') wait = RATE_LIMIT_WAIT_MS;
      // The code only: an error message can quote what the model wrote
      const code = error && typeof error.code === 'string' ? error.code : 'error';
      log.warn(`Live notes were not updated (${code}); the notes so far are kept`);
    } finally {
      state.running = false;
      state.dueAt = now() + wait;
    }

    if (stored) {
      try {
        send(meetingId, ownersOf(meetingId), stored);
      } catch {
        // The notes are stored: a panel that may see them reads them when it next asks
      }
    }
    if (meetings.get(meetingId) === state) consider(meetingId);
    return stored !== null;
  }

  /** Run if a run is due, otherwise make sure a timer will look again. */
  function consider(meetingId) {
    const state = meetings.get(meetingId);
    if (!state || state.running) return;
    if (!store.has(meetingId)) {
      forget(meetingId);
      return;
    }
    if (state.waiting === 0) return; // nothing new: the next line starts things again
    // Given up for now: the next line starts things again (see segmentStored)
    if (state.failures >= MAX_FAILED_RUNS) return;
    const due = now() >= state.dueAt || (!state.attempted && state.waiting >= firstRunSegments);
    if (due && hasReader(meetingId)) {
      runNow(meetingId).catch(() => {
        // runNow handles its own failures; this is only so nothing is ever unhandled
      });
      return;
    }
    // Not due yet, or due with nobody to write for: look again later
    arm(meetingId, state, due ? interval : state.dueAt - now());
  }

  /** A transcript line was stored for this meeting. Never throws. */
  function segmentStored(meetingId) {
    if (!enabled || !isMeetingId(meetingId)) return;
    try {
      if (!store.has(meetingId)) {
        forget(meetingId);
        return;
      }
      const state = stateFor(meetingId);
      state.waiting += 1;
      // Something new to write up: the runs that failed before count no more
      if (state.failures >= MAX_FAILED_RUNS) state.failures = 0;
      consider(meetingId);
    } catch {
      // Writing notes must never get in the way of keeping the transcript
    }
  }

  /**
   * A panel connected or subscribed to this meeting, or the notes became
   * shared: there may be a reader now. If lines are waiting for one, a run
   * follows as soon as one is due.
   * Starts nothing for a meeting without stored lines. Never throws.
   */
  function ownerPanelConnected(meetingId) {
    if (!enabled || !isMeetingId(meetingId) || !meetings.has(meetingId)) return;
    try {
      consider(meetingId);
    } catch {
      // A panel connecting must never fail because of the notes
    }
  }

  return {
    segmentStored, ownerPanelConnected, runNow, forget, size: () => meetings.size,
  };
}

let instance = null;

/** The engine the running server uses. */
function getNotesEngine() {
  if (!instance) {
    // Required here, not at the top: the lifecycle and the WebSocket server
    // require each other's neighbours, and tests build engines without config
    /* eslint-disable global-require */
    const config = require('../config');
    const { getMeetingStore } = require('../storage');
    const { getArloPresence } = require('./arloPresence');
    const { sendNotesUpdated, hasNotesReaderPanel } = require('./websocket');
    const openrouter = require('./openrouter');
    /* eslint-enable global-require */
    instance = createNotesEngine({
      store: getMeetingStore(),
      presence: getArloPresence(),
      // Through the module object, so tests can replace the model call
      generate: (input) => openrouter.generateLiveNotes({ ...input, model: config.notesModel }),
      send: sendNotesUpdated,
      hasOwnerPanel: hasNotesReaderPanel,
      intervalMs: config.notesIntervalMs,
      enabled: config.aiEnabled,
    });
  }
  return instance;
}

module.exports = { createNotesEngine, getNotesEngine, validNotes };
