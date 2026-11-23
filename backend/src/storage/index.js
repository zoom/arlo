/**
 * The meeting store the rest of the backend uses. Chosen once.
 *
 * Interface (what a database implementation must also provide):
 *   appendSegment(meetingId, segment) -> stored segment | null
 *   appendEvent(meetingId, event)     -> stored event with id | null
 *   listSegments(meetingId)           -> segment[]
 *   listEvents(meetingId)             -> event[]
 *   setNotes(meetingId, notes)        -> stored copy | null
 *   getNotes(meetingId)               -> { summary, decisions, actionItems, updatedAt, throughSeqNo } | null
 *   setMeta(meetingId, patch)         -> stored meta | null
 *   setMeta(meetingId, { ownerNameFor: { userId, name } })
 *                                     -> the same; keeps the display name one owner's panel supplied
 *                                        for this meeting (name null removes it), at most 20 per meeting
 *   getMeta(meetingId)                -> { ownerUserId, ownerName, whoCanAsk, ownerNames }
 *                                        (defaults: null, null, 'owner', an empty Map);
 *                                        ownerNames is a Map of Arlo user id -> supplied name, a copy
 *   has(meetingId)                    -> boolean
 *   deleteMeeting(meetingId)          -> boolean
 *   sweep()                           -> number of meetings deleted
 *   size()                            -> number of meetings held
 *
 * setNotes and setMeta only work for a meeting already held (a segment or event
 * was stored) and return null otherwise, so a late write cannot bring back a
 * meeting that was flushed. deleteMeeting and sweep remove notes and meta too.
 *
 * Today there is one implementation: memory. In demo mode that is the design:
 * a meeting's data is held only while the meeting runs and is flushed when it
 * ends, so nothing carries from one meeting (or one customer demo) to the next.
 * With DEMO_MODE off there is no database implementation yet, so memory is used
 * there too, with a warning at startup.
 */
const config = require('../config');
const { createMemoryMeetingStore } = require('./memoryMeetingStore');

let store = null;

function getMeetingStore() {
  if (!store) {
    if (!config.demoMode) {
      console.warn('DEMO_MODE is off, but persistent storage is not implemented: meeting data is held in memory and flushed when the meeting ends.');
    }
    store = createMemoryMeetingStore();
  }
  return store;
}

module.exports = { getMeetingStore };
