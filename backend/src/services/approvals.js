/**
 * Approvals: a question put to the people who brought Arlo into a meeting,
 * which one of them answers in their panel, or which runs out.
 *
 * Today there is one kind, 'share_notes': a participant asks for the notes and
 * an owner agrees to post them to the meeting chat. More kinds are added to
 * APPROVAL_KINDS; nothing else here depends on the kind.
 *
 * What an answer means: the owner's panel does the work (it posts the notes),
 * then reports. `approve: false` is 'declined'; `approve: true, done: true`
 * is 'approved'; `approve: true` without `done: true` is 'failed' (the owner
 * agreed, the work did not happen). The first valid answer closes the
 * approval; an unanswered one closes as 'expired' after `expiryMs`.
 *
 * Kept in memory per meeting and gone with the meeting (`forget`, called from
 * the meeting lifecycle). Bounded: at most `maxPerMeeting` open at once, one
 * per person per kind every ASK_AGAIN_MS, and a bounded memory of who asked.
 * The asker's name is held only while the approval is open. Nothing is logged
 * here: not a name, not a user id.
 */
const crypto = require('node:crypto');

const APPROVAL_KINDS = new Set(['share_notes']);
// One request per person, per kind, per meeting in this long
const ASK_AGAIN_MS = 2 * 60 * 1000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 200;
const MAX_MEETINGS = 5000;

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isKind = (value) => typeof value === 'string' && APPROVAL_KINDS.has(value);

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
  });

  const askerKey = (kind, userId) => `${kind}:${userId}`;

  /** Whether this person may open an approval of this kind in this meeting now. */
  function mayOpen(meetingId, kind, userId) {
    if (!isId(meetingId) || !isKind(kind) || !isId(userId)) return false;
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

  function close(meetingId, meeting, entry, outcome) {
    meeting.open.delete(entry.id);
    if (entry.cancel) entry.cancel();
    entry.cancel = null;
    try {
      onClosed(meetingId, view(entry), outcome);
    } catch {
      // Telling the panels must never undo a close or crash a timer
    }
  }

  /**
   * Open an approval. { id, expiresAt } or null when it is refused: an unknown
   * kind, this person asked a moment ago or has one open, or the meeting has
   * as many open as it takes.
   */
  function open(meetingId, { kind, askedByUserId, askedByName } = {}) {
    if (!mayOpen(meetingId, kind, askedByUserId)) return null;
    let meeting = meetings.get(meetingId);
    if (!meeting) {
      if (meetings.size >= MAX_MEETINGS) return null;
      meeting = { open: new Map(), askedAt: new Map() };
    }
    const key = askerKey(kind, askedByUserId);
    if (meeting.open.size >= maxPerMeeting || !roomForAsker(meeting, key)) return null;
    meetings.set(meetingId, meeting);

    const entry = {
      id: crypto.randomUUID(),
      kind,
      askedByUserId,
      askedByName: typeof askedByName === 'string' && askedByName.length > 0 ? askedByName.slice(0, MAX_NAME_CHARS) : null,
      expiresAt: now() + expiryMs,
      cancel: null,
    };
    meeting.askedAt.set(key, now());
    meeting.open.set(entry.id, entry);
    entry.cancel = schedule(() => {
      entry.cancel = null;
      // Only when it is still the open one: answered or forgotten meanwhile is over
      if (meetings.get(meetingId)?.open.get(entry.id) === entry) close(meetingId, meeting, entry, 'expired');
    }, expiryMs);
    return { id: entry.id, expiresAt: entry.expiresAt };
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
    close(meetingId, meetings.get(meetingId), entry, outcome);
    return outcome;
  }

  /** The meeting's data is gone: so is everything here about it. Nobody is told. */
  function forget(meetingId) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;
    for (const entry of meeting.open.values()) {
      if (entry.cancel) entry.cancel();
      entry.cancel = null;
    }
    meeting.open.clear();
    meeting.askedAt.clear();
    meetings.delete(meetingId);
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

  return { open, answer, get, listOpen, mayOpen, forget, size };
}

let instance = null;

/** What the panels are told about an open approval: the asker's name, never their id. */
const approvalMessageData = (meetingId, approval) => ({
  meetingId,
  id: approval.id,
  kind: approval.kind,
  askedBy: approval.askedByName,
  expiresAt: approval.expiresAt,
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
  createApprovals, getApprovals, approvalMessageData, APPROVAL_KINDS, ASK_AGAIN_MS,
};
