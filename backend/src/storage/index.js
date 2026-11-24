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
 *   getMeta(meetingId)                -> { ownerUserId, ownerName, whoCanAsk, ownerNames, notesShared }
 *                                        (defaults: null, null, 'owner', an empty Map, false);
 *                                        notesShared takes true or false only;
 *                                        ownerNames is a Map of Arlo user id -> supplied name, a copy
 *   setIdentity(meetingId, userId, identity)
 *                                     -> boolean; keeps who one owner's panel says they are in the
 *                                        meeting ({ participantUUID, participantId, screenName }, each a
 *                                        string or null), at most 20 per meeting
 *   listIdentities(meetingId)         -> identity[] (copies)
 *   addIdentityCheck(meetingId, { lines?, idEqualsParticipantId?, idEqualsParticipantUUID?, nameEqualsScreenName? })
 *                                     -> boolean; adds whole numbers to the meeting's counters
 *   getIdentityCheck(meetingId)       -> those four counters and `identities` (how many are held)
 *   appendAction(meetingId, action)   -> stored action with id | null; what Arlo was asked and did:
 *                                        { id, at, tool, label, askedBy, channel, status, public }, with
 *                                        tool a name from services/agent/tools.js (or 'none': no tool
 *                                        was found for the request), label one line of at
 *                                        most 200 characters, askedBy a name or null, channel 'voice' |
 *                                        'panel', status 'pending' | 'waiting_approval' | 'done' |
 *                                        'declined' | 'failed' | 'expired', public a boolean (shown to
 *                                        participants). At most 500 per meeting: at the cap the
 *                                        oldest one that ended is dropped; refused only when all
 *                                        are still open
 *   updateAction(meetingId, id, patch) -> stored action | null; `status` and `label` only, and not for
 *                                        an action that ended (done, declined, failed, expired)
 *   listActions(meetingId)            -> action[], oldest first
 *   has(meetingId)                    -> boolean
 *   deleteMeeting(meetingId)          -> boolean
 *   sweep(onDeleted?)                 -> number of meetings deleted; `onDeleted(meetingId)` is called
 *                                        for each, so state kept elsewhere per meeting can go with it
 *   size()                            -> number of meetings held
 *   onEvicted(listener)               -> `listener(meetingId)` is called when the store drops a meeting
 *                                        itself to make room for a new one (its meeting-count limit),
 *                                        so state kept elsewhere per meeting goes with it; the meeting
 *                                        lifecycle registers its `onForget` here
 *
 * setNotes, setMeta, setIdentity, addIdentityCheck, appendAction and updateAction only work for a meeting already held (a segment or event
 * was stored) and return null otherwise, so a late write cannot bring back a
 * meeting that was flushed. deleteMeeting and sweep remove notes, meta, identities,
 * counters and actions too.
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
