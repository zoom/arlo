/**
 * Approvals: a question put to the people who brought Arlo into a meeting,
 * which one of them answers in their panel, or which runs out.
 *
 * Two kinds:
 *   'share_notes'   a participant asks for the notes and an owner agrees to
 *                   share them with everyone in the meeting. One per person
 *                   every ASK_AGAIN_MS.
 *   'agent_action'  someone asked Arlo for something that an owner has to
 *                   agree to first (services/agent/agent.js decides when). It
 *                   carries the sheet's texts, `question` and `primaryLabel`:
 *                   sentences the server wrote. The asker may have no user id
 *                   (a request spoken in the meeting); how often someone may
 *                   ask is the agent's limit, not this module's.
 *
 * What an answer means: whoever calls answer() does the work first (for
 * 'share_notes' the route turns sharing on, routes/arlo.js), then reports.
 * `approve: false` is 'declined'; `approve: true, done: true` is 'approved';
 * `approve: true` without `done: true` is 'failed' (the owner agreed, the
 * work did not happen). The first valid answer closes the
 * approval; an unanswered one closes as 'expired' after `expiryMs`.
 *
 * Whoever opens an approval can pass `onOutcome(outcome, { byUserId })`: it is
 * called once when the approval ends, with 'approved' | 'declined' | 'failed'
 * | 'expired', or 'forgotten' when the meeting's data went first. That is how
 * the agent waits for the owners' answer.
 *
 * open() answers { id, expiresAt } or null. tryOpen() is the same and says why
 * not: 'too_soon' (this person asked a moment ago or has one open),
 * 'too_many_open' (the meeting, or the service, holds as many as it takes) or
 * 'invalid' (not a request).
 *
 * Kept in memory per meeting and gone with the meeting (`forget`, called from
 * the meeting lifecycle). Bounded: at most `maxPerMeeting` open at once, one
 * 'share_notes' per person every ASK_AGAIN_MS, and a bounded memory of who asked.
 * The asker's name is held only while the approval is open. Nothing is logged
 * here: not a name, not a user id.
 */
const crypto = require('node:crypto');

const APPROVAL_KINDS = new Set(['share_notes', 'agent_action']);
// Kinds a person asks for themselves: one each per ASK_AGAIN_MS, and they must be signed in
const ONE_PER_ASKER = new Set(['share_notes']);
// Kinds whose sheet texts come with the approval
const WITH_TEXTS = new Set(['agent_action']);
const MAX_QUESTION_CHARS = 500;
const MAX_PRIMARY_LABEL_CHARS = 120;
// One request per person, per kind, per meeting in this long
const ASK_AGAIN_MS = 2 * 60 * 1000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 200;
const MAX_MEETINGS = 5000;

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isKind = (value) => typeof value === 'string' && APPROVAL_KINDS.has(value);
/** A sentence for the sheet: a string with something in it, at most `max` characters. */
const isSheetText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

function createApprovals({
  now = Date.now,
  schedule = defaultSchedule,
  expiryMs = 60000,
  maxPerMeeting = 20,
  maxAskersPerMeeting = 500,
  // Called with (meetingId, approval, outcome) when an approval is answered or
  // runs out. Not when its meeting is forgotten: there is nobody left to tell.
  onClosed = () => {},
} = {}) {
  // meetingId -> { open: Map(id -> entry, oldest first), askedAt: Map(kind:userId -> ms) }
  const meetings = new Map();

  const view = (entry) => ({
    id: entry.id,
    kind: entry.kind,
    askedByUserId: entry.askedByUserId,
    askedByName: entry.askedByName,
    expiresAt: entry.expiresAt,
    ...(WITH_TEXTS.has(entry.kind) && { question: entry.question, primaryLabel: entry.primaryLabel }),
  });

  const askerKey = (kind, userId) => `${kind}:${userId}`;

  /** Whether this person may open an approval of this kind in this meeting now. */
  function mayOpen(meetingId, kind, userId) {
    if (!isId(meetingId) || !isKind(kind)) return false;
    // The agent's limits are its own; a request spoken in the meeting has no user
    if (!ONE_PER_ASKER.has(kind)) return userId === null || userId === undefined || isId(userId);
    if (!isId(userId)) return false;
    const meeting = meetings.get(meetingId);
    if (!meeting) return true;
    for (const entry of meeting.open.values()) {
      if (entry.kind === kind && entry.askedByUserId === userId) return false;
    }
    const at = meeting.askedAt.get(askerKey(kind, userId));
    return at === undefined || now() - at >= ASK_AGAIN_MS;
  }

  /** Make room in a meeting's memory of who asked. False when it stays full. */
  function roomForAsker(meeting, key) {
    if (meeting.askedAt.has(key) || meeting.askedAt.size < maxAskersPerMeeting) return true;
    for (const [one, at] of meeting.askedAt) {
      if (now() - at >= ASK_AGAIN_MS) meeting.askedAt.delete(one);
    }
    return meeting.askedAt.size < maxAskersPerMeeting;
  }

  /** Tell whoever opened it how it ended. Once: the entry is closed or forgotten by then. */
  function tellOpener(entry, outcome, byUserId) {
    const { onOutcome } = entry;
    entry.onOutcome = null;
    if (typeof onOutcome !== 'function') return;
    try {
      onOutcome(outcome, { byUserId });
    } catch {
      // The opener's failure is its own
    }
  }

  function close(meetingId, meeting, entry, outcome, byUserId = null) {
    meeting.open.delete(entry.id);
    if (entry.cancel) entry.cancel();
    entry.cancel = null;
    try {
      onClosed(meetingId, view(entry), outcome);
    } catch {
      // Telling the panels must never undo a close or crash a timer
    }
    tellOpener(entry, outcome, byUserId);
  }

  const refuse = (reason) => ({ ok: false, reason });

  /**
   * Open an approval: { ok: true, id, expiresAt }, or { ok: false, reason }:
   *   'invalid'        an unknown kind, no asker where one is needed, or (for
   *                    'agent_action') sheet texts that are missing or too long
   *   'too_soon'       this person asked a moment ago or has one open
   *   'too_many_open'  the meeting has as many open as it takes, remembers as
   *                    many askers as it takes, or the service holds as many
   *                    meetings as it takes
   * Someone who asked a moment ago hears 'too_soon' also while the meeting is full.
   */
  function tryOpen(meetingId, {
    kind, askedByUserId, askedByName, question, primaryLabel, onOutcome,
  } = {}) {
    if (!isId(meetingId) || !isKind(kind)) return refuse('invalid');
    const perAsker = ONE_PER_ASKER.has(kind);
    const noAsker = askedByUserId === null || askedByUserId === undefined;
    if (!isId(askedByUserId) && (perAsker || !noAsker)) return refuse('invalid');
    if (onOutcome !== undefined && typeof onOutcome !== 'function') return refuse('invalid');
    const withTexts = WITH_TEXTS.has(kind);
    if (withTexts && (!isSheetText(question, MAX_QUESTION_CHARS) || !isSheetText(primaryLabel, MAX_PRIMARY_LABEL_CHARS))) {
      return refuse('invalid');
    }
    if (!mayOpen(meetingId, kind, askedByUserId)) return refuse('too_soon');
    let meeting = meetings.get(meetingId);
    if (!meeting) {
      if (meetings.size >= MAX_MEETINGS) return refuse('too_many_open');
      meeting = { open: new Map(), askedAt: new Map() };
    }
    const key = askerKey(kind, askedByUserId);
    if (meeting.open.size >= maxPerMeeting || (perAsker && !roomForAsker(meeting, key))) return refuse('too_many_open');
    meetings.set(meetingId, meeting);

    const entry = {
      id: crypto.randomUUID(),
      kind,
      askedByUserId: isId(askedByUserId) ? askedByUserId : null,
      askedByName: typeof askedByName === 'string' && askedByName.length > 0 ? askedByName.slice(0, MAX_NAME_CHARS) : null,
      expiresAt: now() + expiryMs,
      cancel: null,
      question: withTexts ? question.trim() : null,
      primaryLabel: withTexts ? primaryLabel.trim() : null,
      onOutcome: typeof onOutcome === 'function' ? onOutcome : null,
    };
    if (perAsker) meeting.askedAt.set(key, now());
    meeting.open.set(entry.id, entry);
    entry.cancel = schedule(() => {
      entry.cancel = null;
      // Only when it is still the open one: answered or forgotten meanwhile is over
      if (meetings.get(meetingId)?.open.get(entry.id) === entry) close(meetingId, meeting, entry, 'expired');
    }, expiryMs);
    return { ok: true, id: entry.id, expiresAt: entry.expiresAt };
  }

  /** As tryOpen(): { id, expiresAt }, or null when it is refused, whatever the reason. */
  function open(meetingId, request) {
    const opened = tryOpen(meetingId, request);
    return opened.ok ? { id: opened.id, expiresAt: opened.expiresAt } : null;
  }

  /** The open entry, or null: unknown, closed, or past its time. */
  function openEntry(meetingId, id) {
    if (!isId(meetingId) || !isId(id)) return null;
    const entry = meetings.get(meetingId)?.open.get(id);
    return entry && now() < entry.expiresAt ? entry : null;
  }

  const get = (meetingId, id) => {
    const entry = openEntry(meetingId, id);
    return entry ? view(entry) : null;
  };

  /** A meeting's open approvals, oldest first. */
  function listOpen(meetingId) {
    const meeting = isId(meetingId) ? meetings.get(meetingId) : undefined;
    if (!meeting) return [];
    return [...meeting.open.values()].filter((entry) => now() < entry.expiresAt).map(view);
  }

  /**
   * An owner's answer (the caller checks that they are one).
   * 'approved' | 'declined' | 'failed', or null when there is nothing open
   * under that id or this is not an answer.
   */
  function answer(meetingId, id, { byUserId, approve, done } = {}) {
    if (!isId(byUserId) || typeof approve !== 'boolean') return null;
    if (done !== undefined && typeof done !== 'boolean') return null;
    const entry = openEntry(meetingId, id);
    if (!entry) return null;
    const outcome = approve ? (done === true ? 'approved' : 'failed') : 'declined';
    close(meetingId, meetings.get(meetingId), entry, outcome, byUserId);
    return outcome;
  }

  /**
   * The meeting's data is gone: so is everything here about it. No panel is
   * told; whoever opened an approval and waits for it hears 'forgotten'.
   */
  function forget(meetingId) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;
    const waiting = [...meeting.open.values()];
    for (const entry of waiting) {
      if (entry.cancel) entry.cancel();
      entry.cancel = null;
    }
    meeting.open.clear();
    meeting.askedAt.clear();
    meetings.delete(meetingId);
    for (const entry of waiting) tellOpener(entry, 'forgotten', null);
  }

  /** Counts only, for tests and housekeeping. */
  function size() {
    let openCount = 0;
    let askers = 0;
    for (const meeting of meetings.values()) {
      openCount += meeting.open.size;
      askers += meeting.askedAt.size;
    }
    return { meetings: meetings.size, open: openCount, askers };
  }

  return {
    open, tryOpen, answer, get, listOpen, mayOpen, forget, size,
  };
}

let instance = null;

/** How long until `expiresAt`, in whole milliseconds, never below zero. */
const msLeft = (expiresAt, at = Date.now()) => {
  const left = Math.floor(expiresAt - at);
  return Number.isFinite(left) && left > 0 ? left : 0;
};

/**
 * What the panels are told about an open approval: the asker's name, never
 * their id. `expiresInMs` is the time left by this server's clock at `at`
 * (now, when the message is built): a panel counts down from it, so a device
 * whose clock is off shows the right time. For 'agent_action' also the
 * sheet's texts (`question`, `primaryLabel`), which the server wrote.
 */
const approvalMessageData = (meetingId, approval, at = Date.now()) => ({
  meetingId,
  id: approval.id,
  kind: approval.kind,
  askedBy: approval.askedByName,
  expiresAt: approval.expiresAt,
  expiresInMs: msLeft(approval.expiresAt, at),
  ...(WITH_TEXTS.has(approval.kind) && { question: approval.question, primaryLabel: approval.primaryLabel }),
});

/** The one the running server uses: a close is told to the owners and to the person who asked. */
function getApprovals() {
  if (!instance) {
    /* eslint-disable global-require */
    const config = require('../config');
    instance = createApprovals({
      expiryMs: config.approvalExpiryMs,
      onClosed: (meetingId, approval, outcome) => {
        // Required here: websocket.js and the lifecycle require each other's neighbours
        const { sendApprovalClosed } = require('./websocket');
        const { getArloPresence } = require('./arloPresence');
        /* eslint-enable global-require */
        // The outcome only: never who asked
        console.log(`Arlo approval closed (${approval.kind}, ${outcome})`);
        sendApprovalClosed(meetingId, getArloPresence().ownerUserIds(meetingId), approval.askedByUserId, {
          meetingId, id: approval.id, outcome,
        });
      },
    });
  }
  return instance;
}

module.exports = {
  createApprovals, getApprovals, approvalMessageData, msLeft, APPROVAL_KINDS, ASK_AGAIN_MS,
};
