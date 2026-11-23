/**
 * Which Arlo screen the panel shows. One pure function from confirmed state,
 * so every panel in the same situation shows the same thing.
 *
 * Screens: 'loading' | 'bring-in' | 'ask-host' | 'waiting' | 'notes' | 'participant' | 'after'
 *
 *   guest         not signed in to Arlo
 *   zoomRole      the person's role in the Zoom meeting ('host', 'coHost', 'attendee', …)
 *   arloRole      'owner' | 'participant' from the server; null until Arlo's state arrived
 *   present       the server says Arlo is in the meeting; null until Arlo's state arrived
 *   phase         the transcription phase (lib/rtmsMachine.js)
 *   meetingEnded  Zoom reported that the meeting ended
 *   hasNotes      this panel holds notes
 *   everPresent   Arlo was in this meeting at some point while this panel was open
 */

// A stream that exists. 'interrupted' is the machine's name for reconnecting.
const PRESENT_PHASES = new Set(['active', 'paused', 'reconnecting', 'interrupted']);
// A request is not a state: Arlo is not in the meeting yet.
const WAITING_PHASES = new Set(['requested', 'starting']);
const ZOOM_ROLES_THAT_BRING_ARLO_IN = new Set(['host', 'coHost']);

export function getArloScreen({
  guest, zoomRole, arloRole, present, phase, meetingEnded, hasNotes, everPresent,
}) {
  const owner = arloRole === 'owner';

  if (meetingEnded) return owner && hasNotes ? 'after' : 'participant';

  if (present === true || PRESENT_PHASES.has(phase)) {
    // The stream can be confirmed before the server said who this person is
    // to Arlo: do not show someone else's screen for a moment.
    if (arloRole !== 'owner' && arloRole !== 'participant') return 'loading';
    return owner ? 'notes' : 'participant';
  }

  if (WAITING_PHASES.has(phase)) return 'waiting';

  // Arlo's state not received yet
  if (present !== false) return 'loading';

  // Arlo has left: the owner keeps the notes, with a way to bring Arlo back
  if (owner && hasNotes && everPresent) return 'notes';

  if (guest) return 'participant';
  return ZOOM_ROLES_THAT_BRING_ARLO_IN.has(zoomRole) ? 'bring-in' : 'ask-host';
}

/**
 * Pause, resume, remove and bring back: only an owner, the person whose stream
 * it is. Never a guest, and not a host or co-host who is not an owner: the Apps
 * SDK's pause and stop act on the calling user's own stream, so a host's click
 * in the panel cannot be relied on to affect someone else's. A host stops
 * other people's streams with Zoom's own controls.
 */
export function canControlArlo({ guest, arloRole }) {
  if (guest) return false;
  return arloRole === 'owner';
}
