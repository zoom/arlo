/**
 * Hearing "Arlo, …": finds requests to Arlo in the transcript lines the server
 * stores, and hands each one over once.
 *
 * A request opens when a line, or a sentence inside a line, starts with
 * "Arlo" or "Hey Arlo" followed by more words. "Arlo" in the middle of a
 * sentence is talk about Arlo, not to it, and so are "Arlo's …", "Arlo is …"
 * and "Arlo was …"; the name alone opens nothing.
 *
 * What follows the name is collected, also from the same speaker's next
 * lines (speech arrives in pieces), until one of:
 *   - the speaker is quiet for `settleMs`,
 *   - someone else talks,
 *   - a sentence ends and the request has three words or more,
 *   - the same speaker says "Arlo, …" again,
 *   - `maxMs` have passed since it opened, or it has `maxChars` characters.
 * Then onRequest(meetingId, { text, speakerId, speakerLabel, at }) is called.
 * The same speaker repeating the same request within 10 seconds is heard once.
 *
 * "The same speaker" is the line's speaker id when it has one, else its label.
 *
 * What is heard is untrusted text someone said in a meeting: this module only
 * finds and bounds it. It decides nothing about what may be done, logs
 * nothing, and keeps per meeting only the one open request and the last few
 * heard, until forget(meetingId).
 *
 * The clock and the timers are passed in (`now`, `schedule(fn, ms)` returning
 * a cancel function), so tests run it by hand.
 */
const DEFAULTS = Object.freeze({
  settleMs: 1800, maxMs: 12000, maxChars: 400, maxMeetings: 500,
});
const REPEAT_WINDOW_MS = 10 * 1000;
const MAX_RECENT = 8;
// As long as a stored line (storage/memoryMeetingStore.js) and a stored name
const MAX_LINE_CHARS = 4000;
const MAX_NAME_CHARS = 200;
const MIN_WORDS_TO_CLOSE = 3;

// The name at the start of the line or right after a sentence end, then more
// text. Group 1: the punctuation after the name, if any.
const WAKE = /(?<=^|[.!?]\s+)(?:hey,?\s+)?arlo([,:!.]?)\s+(?=\S)/gi;
// "Arlo is taking notes": about Arlo. "Arlo, is the budget approved?": to Arlo
const ABOUT_ARLO = /^(?:is|was|isn't|wasn't|isn’t|wasn’t)\b/i;
// A sentence with the punctuation that ends it, or what is left without one
const SENTENCE = /[^.!?]*[.!?]+|[^.!?]+$/g;
const ENDS_SENTENCE = /[.!?]$/;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

const oneLine = (value) => value.replace(/\s+/g, ' ').trim();
const wordsIn = (value) => value.match(WORD) || [];
/** A string cut to `max` characters, never ending in half an emoji. */
const cut = (value, max) => (value.length > max ? value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : value);
const nameOrNull = (value) => (typeof value === 'string' && value.trim().length > 0 ? cut(value.trim(), MAX_NAME_CHARS) : null);
/** Two requests are the same when their words are. */
const sameWords = (value) => wordsIn(value.toLowerCase()).join(' ');

function createCommandDetector({
  onRequest, now = Date.now, schedule = defaultSchedule, ...options
} = {}) {
  if (typeof onRequest !== 'function') throw new TypeError('createCommandDetector needs onRequest');
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Number.isInteger(options[key]) && options[key] > 0) limits[key] = options[key];
  }
  // meetingId -> { open: request | null, recent: [{ speaker, words, at }] }
  const meetings = new Map();

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (state) {
      // Move to the end: the first key is the meeting heard from longest ago
      meetings.delete(meetingId);
    } else {
      if (meetings.size >= limits.maxMeetings) drop(meetings.keys().next().value);
      state = { open: null, recent: [] };
    }
    meetings.set(meetingId, state);
    return state;
  }

  function cancelTimers(request) {
    request.cancelSettle?.();
    request.cancelMax?.();
    request.cancelSettle = null;
    request.cancelMax = null;
  }

  /** Remove a meeting's state without hearing what was open. */
  function drop(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    if (state.open) cancelTimers(state.open);
    state.open = null;
    meetings.delete(meetingId);
  }

  /** The open request ends here: heard, unless it is empty or a repeat. */
  function close(meetingId, state) {
    const request = state.open;
    if (!request) return;
    state.open = null;
    cancelTimers(request);
    const text = oneLine(cut(request.text, limits.maxChars));
    const words = sameWords(text);
    if (words.length === 0) return;
    const at = now();
    state.recent = state.recent.filter((one) => at - one.at <= REPEAT_WINDOW_MS);
    if (state.recent.some((one) => one.speaker === request.speaker && one.words === words)) return;
    state.recent.push({ speaker: request.speaker, words, at });
    if (state.recent.length > MAX_RECENT) state.recent.shift();
    try {
      onRequest(meetingId, {
        text, speakerId: request.speakerId, speakerLabel: request.speakerLabel, at: request.at,
      });
    } catch {
      // The handler's failure is its own: the next request is still heard
    }
  }

  /** A timer's turn: only for the request it was set for, if that is still open. */
  const closeIfStill = (meetingId, request) => () => {
    const state = meetings.get(meetingId);
    if (state && state.open === request) close(meetingId, state);
  };

  function open(meetingId, state, who) {
    close(meetingId, state);
    const request = {
      ...who, text: '', at: now(), cancelSettle: null, cancelMax: null,
    };
    state.open = request;
    request.cancelMax = schedule(closeIfStill(meetingId, request), limits.maxMs);
  }

  /** Add what the speaker said to the open request, sentence by sentence. */
  function collect(meetingId, state, piece) {
    const request = state.open;
    for (const sentence of piece.match(SENTENCE) || []) {
      const part = oneLine(sentence);
      if (part.length === 0) continue;
      request.text = request.text.length > 0 ? `${request.text} ${part}` : part;
      const full = request.text.length >= limits.maxChars;
      if (full || (ENDS_SENTENCE.test(part) && wordsIn(request.text).length >= MIN_WORDS_TO_CLOSE)) {
        close(meetingId, state);
        return; // what the speaker says after it is not for Arlo
      }
    }
    // Still open: the quiet time starts again
    request.cancelSettle?.();
    request.cancelSettle = schedule(closeIfStill(meetingId, request), limits.settleMs);
  }

  /**
   * One stored transcript line: { speakerId, speakerLabel, text, tStartMs }.
   * Anything that is not a line is ignored. Never throws.
   */
  function lineStored(meetingId, line) {
    if (typeof meetingId !== 'string' || meetingId.length === 0) return;
    if (line === null || typeof line !== 'object' || typeof line.text !== 'string') return;
    // Runs of spaces become one: the patterns below then read a line in one pass
    const text = oneLine(cut(line.text, MAX_LINE_CHARS));
    if (text.length === 0) return;
    const speakerId = line.speakerId === 'unknown' ? null : nameOrNull(line.speakerId);
    const speakerLabel = nameOrNull(line.speakerLabel);
    const who = {
      speaker: speakerId !== null ? `id:${speakerId}` : `label:${speakerLabel ?? ''}`, speakerId, speakerLabel,
    };

    // Where requests start in this line
    const wakes = [];
    for (const match of text.matchAll(WAKE)) {
      const after = match.index + match[0].length;
      const about = match[1] === '' && ABOUT_ARLO.test(text.slice(after));
      if (!about) wakes.push({ from: match.index, after });
    }
    const existing = meetings.get(meetingId);
    const continues = Boolean(existing?.open) && existing.open.speaker === who.speaker;
    // A line with nothing for Arlo in a meeting with nothing open keeps no state
    if (wakes.length === 0 && !existing?.open) return;

    const state = stateFor(meetingId);
    if (state.open && !continues) close(meetingId, state); // someone else talks
    const head = text.slice(0, wakes.length > 0 ? wakes[0].from : text.length);
    if (state.open && head.trim().length > 0) collect(meetingId, state, head);
    wakes.forEach((wake, index) => {
      open(meetingId, state, who);
      const until = index + 1 < wakes.length ? wakes[index + 1].from : text.length;
      collect(meetingId, state, text.slice(wake.after, until));
    });
  }

  /** The meeting is over: nothing of it is kept, and nothing open is heard. */
  function forget(meetingId) {
    drop(meetingId);
  }

  return { lineStored, forget, tracked: () => meetings.size };
}

module.exports = { createCommandDetector };
