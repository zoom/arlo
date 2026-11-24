/**
 * Share a meeting's notes with everyone in it who has Arlo open, or stop: the
 * one way it happens, for the owner's setting (PUT …/arlo/settings), for an
 * approved request for the notes, and for Arlo's `share_notes` tool alike.
 *
 * shareNotes(meetingId, userId, value) -> 'refused' when this person is not an
 * owner of the meeting (or its data is gone), 'unchanged' when it was so
 * already, 'changed' otherwise.
 *
 * On a change every panel is told the new state first, so a panel knows the
 * notes are shared before any arrive, and that they are not the moment
 * sharing stops (from then on sendNotesUpdated() reaches owners only). Turned
 * on, the notes so far go to everyone who may now see them, the requests for
 * them that were still open are answered, and the notes engine looks again:
 * a participant's panel may be the reader it was waiting for.
 */
const { getMeetingStore } = require('../storage');
const { getArloPresence } = require('./arloPresence');
const { getApprovals } = require('./approvals');
const { broadcastArloState, sendNotesUpdated } = require('./websocket');
const { getNotesEngine } = require('./notesEngine');

function shareNotes(meetingId, userId, value) {
  const presence = getArloPresence();
  const outcome = presence.setNotesShared(meetingId, userId, value);
  if (outcome !== 'changed') return outcome;
  // That it happened: never who did it
  console.log(`Arlo setting changed: notes sharing ${value ? 'on' : 'off'}`);
  broadcastArloState(meetingId);
  if (!value) return outcome;
  const notes = getMeetingStore().getNotes(meetingId);
  if (notes) sendNotesUpdated(meetingId, presence.ownerUserIds(meetingId), notes);
  const approvals = getApprovals();
  for (const approval of approvals.listOpen(meetingId)) {
    if (approval.kind === 'share_notes') approvals.answer(meetingId, approval.id, { byUserId: userId, approve: true, done: true });
  }
  getNotesEngine().ownerPanelConnected(meetingId);
  return outcome;
}

module.exports = { shareNotes };
