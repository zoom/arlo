/**
 * Is the person who said a transcript line one of the meeting's owners?
 *
 * A spoken request runs without the owners' approval only when this says yes,
 * so it says yes only on an exact id match, in the way the deployment chose
 * with AGENT_SPEAKER_MATCH:
 *
 *   none              (default) nobody is ever verified by voice: every spoken
 *                     request is treated as coming from someone else
 *   participant_id    the line's speaker id equals the `participantId` an
 *                     owner's panel reported for this meeting
 *   participant_uuid  the line's speaker id equals a reported `participantUUID`
 *
 * The reported identities are the ones owners' panels posted
 * (POST …/arlo/identity, kept with the meeting and deleted with it). Which
 * value, if any, equals the transcript's speaker id is measured per deployment
 * (GET …/arlo/identity-check); until that is known the setting stays `none`.
 *
 * A name is never used: anyone can rename themselves in a meeting.
 */
const SPEAKER_MATCH_MODES = Object.freeze(['none', 'participant_id', 'participant_uuid']);
const FIELD = Object.freeze({ participant_id: 'participantId', participant_uuid: 'participantUUID' });
const MAX_ID_CHARS = 200;

/**
 * The setting as it is used: one of the modes above. Anything else (unset,
 * mistyped, another case) is 'none', with `known: false` when it was set to
 * something that is not a mode, so the caller can warn.
 */
function readSpeakerMatchMode(raw) {
  if (raw === undefined || raw === null || raw === '') return { mode: 'none', known: true };
  if (typeof raw === 'string' && SPEAKER_MATCH_MODES.includes(raw)) return { mode: raw, known: true };
  return { mode: 'none', known: false };
}

function createSpeakerMatch({ mode, store } = {}) {
  const field = typeof mode === 'string' && Object.prototype.hasOwnProperty.call(FIELD, mode) ? FIELD[mode] : null;

  /** (meetingId, { speakerId, speakerLabel }) -> boolean. Never throws. */
  return function isVerifiedOwnerSpeaker(meetingId, speaker) {
    if (field === null || speaker === null || typeof speaker !== 'object') return false;
    if (typeof speaker.speakerId !== 'string') return false;
    const speakerId = speaker.speakerId.trim();
    // 'unknown' is what the store writes for a line without a speaker id
    if (speakerId.length === 0 || speakerId.length > MAX_ID_CHARS || speakerId === 'unknown') return false;
    try {
      return store.listIdentities(meetingId).some((one) => typeof one[field] === 'string' && one[field] === speakerId);
    } catch {
      return false;
    }
  };
}

module.exports = { createSpeakerMatch, readSpeakerMatchMode, SPEAKER_MATCH_MODES };
