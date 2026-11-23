/**
 * The meeting store the rest of the backend uses. Chosen once.
 *
 * Interface (what a database implementation must also provide):
 *   appendSegment(meetingId, segment) -> stored segment | null
 *   appendEvent(meetingId, event)     -> stored event with id | null
 *   listSegments(meetingId)           -> segment[]
 *   listEvents(meetingId)             -> event[]
 *   has(meetingId)                    -> boolean
 *   deleteMeeting(meetingId)          -> boolean
 *   sweep()                           -> number of meetings deleted
 *   size()                            -> number of meetings held
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
