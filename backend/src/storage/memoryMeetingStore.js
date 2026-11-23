/**
 * What the server holds for a meeting while it runs: transcript segments and
 * timeline events, in memory only. Nothing here touches disk. A meeting's data
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

const isMeetingId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

function createMemoryMeetingStore(options = {}) {
  const { now = Date.now } = options;
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Number.isInteger(options[key]) && options[key] > 0) limits[key] = options[key];
  }
  const meetings = new Map(); // meetingId -> { createdAt, segments, events, nextSeqNo }

  function entryFor(meetingId) {
    let entry = meetings.get(meetingId);
    if (!entry) {
      if (meetings.size >= limits.maxMeetings) {
        // Map keeps insertion order: the first key is the oldest meeting
        meetings.delete(meetings.keys().next().value);
      }
      entry = { createdAt: now(), segments: [], events: [], nextSeqNo: 1 };
      meetings.set(meetingId, entry);
    }
    return entry;
  }

  /** Store one transcript segment. Returns the stored copy, or null if refused. */
  function appendSegment(meetingId, raw) {
    if (!isMeetingId(meetingId) || raw === null || typeof raw !== 'object' || typeof raw.text !== 'string') {
      return null;
    }
    const entry = entryFor(meetingId);
    const seqNo = finite(raw.seqNo, entry.nextSeqNo);
    entry.nextSeqNo = Math.max(entry.nextSeqNo, seqNo + 1);
    const tStartMs = finite(raw.tStartMs, now());
    const segment = {
      seqNo,
      text: raw.text.slice(0, MAX_TEXT_CHARS),
      speakerId: clip(raw.speakerId, MAX_NAME_CHARS) || 'unknown',
      speakerLabel: clip(raw.speakerLabel, MAX_NAME_CHARS) || 'Speaker',
      tStartMs,
      tEndMs: finite(raw.tEndMs, tStartMs),
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
      eventType: raw.eventType.slice(0, MAX_EVENT_TYPE_CHARS),
      participantName: clip(raw.participantName, MAX_NAME_CHARS),
      participantId: clip(raw.participantId, MAX_NAME_CHARS),
      timestamp: finite(raw.timestamp, now()),
    };
    entry.events.push(event);
    if (entry.events.length > limits.maxEventsPerMeeting) entry.events.shift();
    return { ...event };
  }

  const listSegments = (meetingId) => (meetings.get(meetingId)?.segments || []).map((s) => ({ ...s }));
  const listEvents = (meetingId) => (meetings.get(meetingId)?.events || []).map((e) => ({ ...e }));
  const has = (meetingId) => meetings.has(meetingId);
  const deleteMeeting = (meetingId) => meetings.delete(meetingId);
  const size = () => meetings.size;

  /** Delete meetings older than the age limit. Returns how many were deleted. */
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

  return { appendSegment, appendEvent, listSegments, listEvents, has, deleteMeeting, sweep, size };
}

module.exports = { createMemoryMeetingStore };
