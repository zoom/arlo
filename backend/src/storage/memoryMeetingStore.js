/**
 * What the server holds for a meeting while it runs: transcript segments,
 * timeline events, the notes written from them, what Arlo was asked and did,
 * and a few facts about the
 * meeting (who brought Arlo in, who may ask, whether the notes are shared with
 * everyone in it), in memory only. Nothing here touches disk. A meeting's data
 * is removed by deleteMeeting() (see services/meetingLifecycle.js) or by
 * sweep() once it is older than the age limit.
 *
 * Everything stored is rebuilt from known fields with bounded sizes, so a
 * caller cannot store arbitrary objects. Lists are returned as copies.
 * Never log what this module holds.
 */
const crypto = require('crypto');
const { cleanName } = require('../lib/displayName');
const { ALL_TOOL_NAMES } = require('../services/agent/tools');

const DEFAULTS = Object.freeze({
  maxMeetings: 500,
  maxSegmentsPerMeeting: 20000,
  maxEventsPerMeeting: 2000,
  maxActionsPerMeeting: 500,
  maxAgeMs: 12 * 60 * 60 * 1000,
});
const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 4000;
const MAX_NAME_CHARS = 200;
const MAX_EVENT_TYPE_CHARS = 50;
const MAX_SUMMARY_CHARS = 1500;
const MAX_NOTE_LINE_CHARS = 300;
const MAX_DECISIONS = 20;
const MAX_ACTION_ITEMS = 30;
// Names the owners' own panels supplied (see setMeta `ownerNameFor`): one per
// owner, and a meeting has at most 20 streams
const MAX_OWNER_NAMES = 20;
// Who an owner's panel says they are in the meeting (see setIdentity):
// one per owner, like the names above
const MAX_IDENTITIES = 20;
const IDENTITY_FIELDS = Object.freeze(['participantUUID', 'participantId', 'screenName']);
const IDENTITY_COUNTERS = Object.freeze(['lines', 'idEqualsParticipantId', 'idEqualsParticipantUUID', 'nameEqualsScreenName']);
const WHO_CAN_ASK = new Set(['owner', 'anyone']);
// What Arlo was asked and did (appendAction)
const MAX_ACTION_LABEL_CHARS = 200;
const ACTION_CHANNELS = new Set(['voice', 'panel']);
const ACTION_STATUSES = new Set(['pending', 'waiting_approval', 'done', 'declined', 'failed', 'expired']);
// How an action can end. One that ended is not changed again
const ACTION_ENDED = new Set(['done', 'declined', 'failed', 'expired']);
// Not shown as text: control and invisible format characters, private-use and
// unassigned ones, lone surrogates, line and paragraph separators
const NOT_SHOWN = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;

const MAX_SEQ_NO = 2 ** 31;

const isMeetingId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
/**
 * A string cut to `max` characters. The cut value is a fresh copy: a plain
 * slice() keeps the whole original string alive in memory, which would let one
 * oversized value defeat the limit. The copy also repairs a split emoji.
 */
const bounded = (value, max) => (value.length > max ? Buffer.from(value.slice(0, max), 'utf8').toString('utf8') : value);
const clip = (value, max) => (typeof value === 'string' ? bounded(value, max) : null);
const isTime = (value) => Number.isFinite(value) && value >= 0;
const isSeqNo = (value) => Number.isSafeInteger(value) && value >= 0 && value < MAX_SEQ_NO;
const isText = (value) => typeof value === 'string' && value.length > 0;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const zeroIdentityCheck = () => Object.fromEntries(IDENTITY_COUNTERS.map((key) => [key, 0]));
const defaultMeta = () => ({
  ownerUserId: null, ownerName: null, whoCanAsk: 'owner', ownerNames: new Map(), notesShared: false,
});
/** A copy to hand out: the Map inside is copied too. */
const copyMeta = (meta) => ({ ...meta, ownerNames: new Map(meta.ownerNames) });
/**
 * An identity rebuilt from its known fields, each a trimmed, bounded string or
 * null; null when none of them is there.
 */
function readIdentity(raw) {
  if (!isPlainObject(raw)) return null;
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    const value = typeof raw[field] === 'string' ? bounded(raw[field].trim(), MAX_NAME_CHARS).trim() : '';
    identity[field] = value.length > 0 ? value : null;
  }
  return IDENTITY_FIELDS.some((field) => identity[field] !== null) ? identity : null;
}
/**
 * An action's label as it is kept: one line of plain text, at most 200
 * characters; null when nothing is left of it.
 */
function readActionLabel(value) {
  if (typeof value !== 'string') return null;
  const oneLine = value.replace(NOT_SHOWN, ' ').replace(/\s+/gu, ' ').trim();
  const label = bounded(oneLine, MAX_ACTION_LABEL_CHARS).trim();
  return label.length > 0 ? label : null;
}
const copyNotes = (notes) => ({
  ...notes,
  decisions: [...notes.decisions],
  actionItems: notes.actionItems.map((item) => ({ ...item })),
});

function createMemoryMeetingStore(options = {}) {
  const { now = Date.now } = options;
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Number.isInteger(options[key]) && options[key] > 0) limits[key] = options[key];
  }
  const meetings = new Map(); // meetingId -> { createdAt, segments, events, nextSeqNo, notes, meta }

  function entryFor(meetingId) {
    let entry = meetings.get(meetingId);
    if (entry) {
      // Move to the end: the Map's first key is then the meeting written to longest ago
      meetings.delete(meetingId);
    } else {
      if (meetings.size >= limits.maxMeetings) {
        meetings.delete(meetings.keys().next().value);
      }
      entry = {
        createdAt: now(),
        segments: [],
        events: [],
        nextSeqNo: 1,
        notes: null,
        meta: defaultMeta(),
        identities: new Map(),
        identityCheck: zeroIdentityCheck(),
        actions: [],
      };
    }
    meetings.set(meetingId, entry);
    return entry;
  }

  /** Store one transcript segment. Returns the stored copy, or null if refused. */
  function appendSegment(meetingId, raw) {
    if (!isMeetingId(meetingId) || raw === null || typeof raw !== 'object'
        || typeof raw.text !== 'string' || raw.text.length === 0) {
      return null;
    }
    const entry = entryFor(meetingId);
    // The store numbers the lines itself. The number a line arrives with is its
    // stream's own count, and a meeting's lines come from whichever of its
    // streams delivers them first (see services/meetingStreams.js), so those
    // counts can repeat or jump. Numbers given here never repeat, skip or go backwards.
    const seqNo = entry.nextSeqNo;
    entry.nextSeqNo = Math.min(seqNo + 1, MAX_SEQ_NO - 1);
    const tStartMs = isTime(raw.tStartMs) ? raw.tStartMs : now();
    const segment = {
      seqNo,
      text: bounded(raw.text, MAX_TEXT_CHARS),
      speakerId: clip(raw.speakerId, MAX_NAME_CHARS) || 'unknown',
      speakerLabel: clip(raw.speakerLabel, MAX_NAME_CHARS) || 'Speaker',
      tStartMs,
      tEndMs: isTime(raw.tEndMs) && raw.tEndMs >= tStartMs ? raw.tEndMs : tStartMs,
    };
    entry.segments.push(segment);
    if (entry.segments.length > limits.maxSegmentsPerMeeting) entry.segments.shift();
    return { ...segment };
  }

  /** Store one timeline event. Returns the stored copy (with an id), or null if refused. */
  function appendEvent(meetingId, raw) {
    if (!isMeetingId(meetingId) || raw === null || typeof raw !== 'object'
        || typeof raw.eventType !== 'string' || raw.eventType.length === 0) {
      return null;
    }
    const entry = entryFor(meetingId);
    const event = {
      id: crypto.randomUUID(),
      eventType: bounded(raw.eventType, MAX_EVENT_TYPE_CHARS),
      participantName: clip(raw.participantName, MAX_NAME_CHARS),
      participantId: clip(raw.participantId, MAX_NAME_CHARS),
      timestamp: isTime(raw.timestamp) ? raw.timestamp : now(),
    };
    entry.events.push(event);
    if (entry.events.length > limits.maxEventsPerMeeting) entry.events.shift();
    return { ...event };
  }

  /**
   * Replace the meeting's notes. Returns the stored copy, or null if refused.
   * Only for a meeting already held (a segment or event was stored): notes that
   * arrive late, after the flush, must not bring the meeting back. Looked up
   * without entryFor(), so writing notes neither creates a meeting nor counts
   * as it being in use.
   */
  function setNotes(meetingId, raw) {
    const entry = meetings.get(meetingId);
    if (!entry || !isPlainObject(raw) || typeof raw.summary !== 'string' || !isSeqNo(raw.throughSeqNo)) {
      return null;
    }
    const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
      .filter(isText)
      .slice(0, MAX_DECISIONS)
      .map((line) => bounded(line, MAX_NOTE_LINE_CHARS));
    const actionItems = (Array.isArray(raw.actionItems) ? raw.actionItems : [])
      .filter((item) => isPlainObject(item) && isText(item.text))
      .slice(0, MAX_ACTION_ITEMS)
      .map((item) => ({
        text: bounded(item.text, MAX_NOTE_LINE_CHARS),
        owner: isText(item.owner) ? bounded(item.owner, MAX_NAME_CHARS) : null,
      }));
    entry.notes = {
      summary: bounded(raw.summary, MAX_SUMMARY_CHARS),
      decisions,
      actionItems,
      updatedAt: now(),
      throughSeqNo: raw.throughSeqNo,
    };
    return copyNotes(entry.notes);
  }

  const getNotes = (meetingId) => {
    const notes = meetings.get(meetingId)?.notes;
    return notes ? copyNotes(notes) : null;
  };

  /**
   * Change facts about the meeting. Only the known keys are read; a key with a
   * value that is not allowed is left as it was. Returns the stored meta, or
   * null for a meeting not held (same reason as setNotes).
   *
   * `ownerNameFor: { userId, name }` keeps the display name one owner's panel
   * supplied for this meeting (`name: null` removes it). They are read from
   * `ownerNames`, a Map of Arlo user id -> name with at most 20 entries: when
   * it is full, a name for someone not in it is not taken.
   */
  function setMeta(meetingId, patch) {
    const entry = meetings.get(meetingId);
    if (!entry) return null;
    if (isPlainObject(patch)) {
      const { meta } = entry;
      // An id that is too long is not cut: a cut id would name someone else
      if (hasOwn(patch, 'ownerUserId') && (patch.ownerUserId === null || isMeetingId(patch.ownerUserId))) {
        meta.ownerUserId = patch.ownerUserId;
      }
      if (hasOwn(patch, 'ownerName') && (patch.ownerName === null || isText(patch.ownerName))) {
        meta.ownerName = clip(patch.ownerName, MAX_NAME_CHARS);
      }
      if (hasOwn(patch, 'whoCanAsk') && WHO_CAN_ASK.has(patch.whoCanAsk)) {
        meta.whoCanAsk = patch.whoCanAsk;
      }
      // Whether the notes are shared with everyone in the meeting: true or false, nothing else
      if (hasOwn(patch, 'notesShared') && typeof patch.notesShared === 'boolean') {
        meta.notesShared = patch.notesShared;
      }
      if (hasOwn(patch, 'ownerNameFor') && isPlainObject(patch.ownerNameFor)) {
        const { userId, name } = patch.ownerNameFor;
        const cleaned = typeof name === 'string' ? bounded(name.trim(), MAX_NAME_CHARS).trim() : '';
        if (isMeetingId(userId)) {
          if (name === null) meta.ownerNames.delete(userId);
          else if (cleaned.length > 0 && (meta.ownerNames.has(userId) || meta.ownerNames.size < MAX_OWNER_NAMES)) {
            meta.ownerNames.set(userId, cleaned);
          }
        }
      }
    }
    return copyMeta(entry.meta);
  }

  const getMeta = (meetingId) => copyMeta(meetings.get(meetingId)?.meta || defaultMeta());

  /**
   * Keep who one owner's panel says they are in the meeting
   * ({ participantUUID?, participantId?, screenName? }): one per Arlo user id,
   * at most 20 per meeting; when full, one for someone not held is not taken.
   * Only for a meeting already held, like setNotes. Returns whether it is kept.
   * A measurement (services/arloPresence.js lineStored): nothing else reads it.
   */
  function setIdentity(meetingId, userId, raw) {
    const entry = meetings.get(meetingId);
    const identity = readIdentity(raw);
    if (!entry || !isMeetingId(userId) || !identity) return false;
    if (!entry.identities.has(userId) && entry.identities.size >= MAX_IDENTITIES) return false;
    entry.identities.set(userId, identity);
    return true;
  }

  /** The identities held for a meeting, as copies, without whose they are. */
  const listIdentities = (meetingId) => [...(meetings.get(meetingId)?.identities.values() || [])].map((one) => ({ ...one }));

  /** Add whole numbers to the meeting's identity counters. Other keys and values are ignored. */
  function addIdentityCheck(meetingId, counts) {
    const entry = meetings.get(meetingId);
    if (!entry || !isPlainObject(counts)) return false;
    for (const key of IDENTITY_COUNTERS) {
      const add = counts[key];
      if (Number.isSafeInteger(add) && add > 0) {
        entry.identityCheck[key] = Math.min(entry.identityCheck[key] + add, Number.MAX_SAFE_INTEGER);
      }
    }
    return true;
  }

  /** The counters and how many identities are held: numbers only. */
  function getIdentityCheck(meetingId) {
    const entry = meetings.get(meetingId);
    return { ...(entry ? entry.identityCheck : zeroIdentityCheck()), identities: entry ? entry.identities.size : 0 };
  }

  /**
   * Record something Arlo was asked to do. Returns the stored copy (with an id
   * and a time), or null if refused.
   *
   * Rebuilt from known fields: `tool` (a name from the tool table), `label`
   * (what Arlo did, a sentence the server wrote from a template, never a
   * model's text; cleaned to one line of at most 200 characters), `askedBy`
   * (a name or null), `channel` ('voice' | 'panel'), `status` ('pending' when
   * not given), `public` (shown to participants: only `true` is), `at` (now
   * when not given). What a tool was called with is not kept.
   *
   * Only for a meeting already held, like setNotes: an action that ends after
   * the flush must not bring the meeting back. At most 500 per meeting; more
   * are refused, so the record never loses an action it took.
   */
  function appendAction(meetingId, raw) {
    const entry = meetings.get(meetingId);
    if (!entry || !isPlainObject(raw) || entry.actions.length >= limits.maxActionsPerMeeting) return null;
    const label = readActionLabel(raw.label);
    const status = hasOwn(raw, 'status') ? raw.status : 'pending';
    if (typeof raw.tool !== 'string' || !ALL_TOOL_NAMES.includes(raw.tool) || label === null
        || !ACTION_CHANNELS.has(raw.channel) || !ACTION_STATUSES.has(status)) {
      return null;
    }
    const action = {
      id: crypto.randomUUID(),
      at: isTime(raw.at) ? raw.at : now(),
      tool: raw.tool,
      label,
      askedBy: cleanName(raw.askedBy, MAX_NAME_CHARS) || null,
      channel: raw.channel,
      status,
      public: raw.public === true,
    };
    entry.actions.push(action);
    return { ...action };
  }

  /**
   * Change an action's `status`, its `label`, or both; nothing else of it can
   * change. Returns the stored copy, or null when refused: an unknown meeting
   * or id, a value that is not allowed (then nothing is changed), nothing to
   * change, or an action that already ended (done, declined, failed, expired).
   */
  function updateAction(meetingId, id, patch) {
    const action = meetings.get(meetingId)?.actions.find((one) => one.id === id);
    if (!action || !isPlainObject(patch) || ACTION_ENDED.has(action.status)) return null;
    const hasStatus = hasOwn(patch, 'status');
    const hasLabel = hasOwn(patch, 'label');
    const label = hasLabel ? readActionLabel(patch.label) : null;
    if ((!hasStatus && !hasLabel) || (hasStatus && !ACTION_STATUSES.has(patch.status)) || (hasLabel && label === null)) {
      return null;
    }
    if (hasStatus) action.status = patch.status;
    if (hasLabel) action.label = label;
    return { ...action };
  }

  /** The meeting's actions, oldest first, as copies. */
  const listActions = (meetingId) => (meetings.get(meetingId)?.actions || []).map((action) => ({ ...action }));

  const listSegments = (meetingId) => (meetings.get(meetingId)?.segments || []).map((s) => ({ ...s }));
  const listEvents = (meetingId) => (meetings.get(meetingId)?.events || []).map((e) => ({ ...e }));
  const has = (meetingId) => meetings.has(meetingId);
  const deleteMeeting = (meetingId) => meetings.delete(meetingId);
  const size = () => meetings.size;

  /**
   * Delete meetings older than the age limit, counted from when the meeting's
   * first line arrived. This is a hard ceiling on how long anything is held,
   * so it applies to a meeting that is still running too.
   * Returns how many were deleted.
   */
  function sweep() {
    let deleted = 0;
    for (const [meetingId, entry] of meetings) {
      if (now() - entry.createdAt > limits.maxAgeMs) {
        meetings.delete(meetingId);
        deleted += 1;
      }
    }
    return deleted;
  }

  return {
    appendSegment, appendEvent, listSegments, listEvents,
    setNotes, getNotes, setMeta, getMeta,
    setIdentity, listIdentities, addIdentityCheck, getIdentityCheck,
    appendAction, updateAction, listActions,
    has, deleteMeeting, sweep, size,
  };
}

module.exports = { createMemoryMeetingStore };
