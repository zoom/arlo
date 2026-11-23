/**
 * What the server holds for a meeting while it runs: transcript segments,
 * timeline events, the notes written from them and a few facts about the
 * meeting (who brought Arlo in, who may ask), in memory only. Nothing here touches disk. A meeting's data
 * is removed by deleteMeeting() (see services/meetingLifecycle.js) or by
 * sweep() once it is older than the age limit.
 *
 * Everything stored is rebuilt from known fields with bounded sizes, so a
 * caller cannot store arbitrary objects. Lists are returned as copies.
 * Never log what this module holds.
 */
const crypto = require('crypto');

const DEFAULTS = Object.freeze({
  maxMeetings: 500,
  maxSegmentsPerMeeting: 20000,
  maxEventsPerMeeting: 2000,
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
const WHO_CAN_ASK = new Set(['owner', 'anyone']);

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

const defaultMeta = () => ({ ownerUserId: null, ownerName: null, whoCanAsk: 'owner' });
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
      entry = { createdAt: now(), segments: [], events: [], nextSeqNo: 1, notes: null, meta: defaultMeta() };
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
    // A sequence number that is not a sane whole number is replaced, so one bad
    // value cannot break the numbering of the lines that follow
    const seqNo = isSeqNo(raw.seqNo) ? raw.seqNo : entry.nextSeqNo;
    entry.nextSeqNo = Math.min(Math.max(entry.nextSeqNo, seqNo + 1), MAX_SEQ_NO - 1);
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
    }
    return { ...entry.meta };
  }

  const getMeta = (meetingId) => ({ ...(meetings.get(meetingId)?.meta || defaultMeta()) });

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
    has, deleteMeeting, sweep, size,
  };
}

module.exports = { createMemoryMeetingStore };
