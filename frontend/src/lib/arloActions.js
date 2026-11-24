/**
 * The panel as Arlo's hands: what Arlo can only do through the Zoom Apps SDK.
 * The server decides what is done and sends it to one owner's panel as an
 * action ({ tool, args }); the panel runs it here and reports
 * { ok: true } or { ok: false, code }.
 *
 *   post_to_chat             { message }   into the meeting chat, for everyone
 *   admit_from_waiting_room  { name }      host or co-host only
 *
 * Codes: 'unsupported' (not a tool of this panel, arguments it cannot use, or
 * a Zoom client without the API), 'not_allowed' (this person's Zoom role may
 * not, or this panel may no longer act for Arlo), 'not_found' (nobody in the
 * waiting room by that name), 'several_match' (more than one person has that
 * exact name, or the name is only the first word of someone's: Arlo then asks
 * for the full name), 'sdk_error' (Zoom refused or failed).
 *
 * Only the person the owner approved is admitted: the sheet named them, so
 * the name must be someone's whole name, and exactly one person's.
 *
 * The arguments are checked again here although the server checked them: this
 * is the last step before Zoom acts. Nothing is logged: a message, a name and
 * Zoom's error text are meeting content.
 */
export const HAND_TOOLS = Object.freeze({
  chat: 'post_to_chat',
  admit: 'admit_from_waiting_room',
});

// Who may let people in from the waiting room (Zoom's rule for both APIs)
const MAY_ADMIT = new Set(['host', 'coHost']);
// "Arlo: " and an answer of up to 500 characters
const MAX_MESSAGE_CHARS = 510;
const MAX_NAME_CHARS = 100;
// More people than this in a waiting room are not looked through
const MAX_WAITING = 1000;

const ok = Object.freeze({ ok: true });
const fail = (code) => ({ ok: false, code });
const has = (zoomSdk, method) => typeof zoomSdk?.[method] === 'function';

/**
 * What this panel tells the server it can do (`arlo.hands`): the chat when
 * the client accepted it, the waiting room when the client accepted its APIs
 * and Zoom says this person is the host or a co-host.
 */
export function handsFor({ chatSupported, waitingRoomSupported, zoomRole }) {
  const can = [];
  if (chatSupported === true) can.push(HAND_TOOLS.chat);
  if (waitingRoomSupported === true && MAY_ADMIT.has(zoomRole)) can.push(HAND_TOOLS.admit);
  return can;
}

/** A name for comparing: NFC, no case, single spaces. */
const comparable = (value) => (
  typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() : ''
);

async function postToChat(zoomSdk, args) {
  const message = typeof args?.message === 'string' ? args.message : '';
  if (message.trim().length === 0 || message.length > MAX_MESSAGE_CHARS) return fail('unsupported');
  if (!has(zoomSdk, 'sendMessageToChat')) return fail('unsupported');
  // Same call as lib/postNotes.js
  await zoomSdk.sendMessageToChat({ message });
  return ok;
}

async function admitFromWaitingRoom(zoomSdk, args, zoomRole, stillAllowed) {
  const asked = typeof args?.name === 'string' && args.name.length <= MAX_NAME_CHARS ? comparable(args.name) : '';
  if (asked === '') return fail('unsupported');
  if (!has(zoomSdk, 'getWaitingRoomParticipants') || !has(zoomSdk, 'admitParticipantFromWaitingRoom')) return fail('unsupported');
  if (!MAY_ADMIT.has(zoomRole)) return fail('not_allowed');

  const answer = await zoomSdk.getWaitingRoomParticipants();
  // The list took a while: this panel may have stopped being an owner's, the
  // person may have signed out, the meeting may be another one or over
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');
  if (!Array.isArray(answer?.participants)) return fail('sdk_error');
  const people = answer.participants.slice(0, MAX_WAITING)
    .map((person) => ({ name: comparable(person?.screenName), participantUUID: person?.participantUUID }))
    .filter((person) => person.name !== '');

  // The whole name, and exactly one person by it. A first name alone admits
  // nobody: the owner approved "Sam", not whoever's name starts with it.
  const matches = people.filter((person) => person.name === asked);
  if (matches.length > 1) return fail('several_match');
  if (matches.length === 0) {
    return fail(people.some((person) => person.name.split(' ')[0] === asked) ? 'several_match' : 'not_found');
  }
  const { participantUUID } = matches[0];
  if (typeof participantUUID !== 'string' || participantUUID.length === 0) return fail('sdk_error');
  await zoomSdk.admitParticipantFromWaitingRoom({ participantUUID });
  return ok;
}

/**
 * Run one action with the Zoom Apps SDK. `zoomRole`: this person's role in
 * the Zoom meeting, as Zoom reports it. `stillAllowed()`: true while this
 * panel may still act for Arlo (an owner's, signed in, in the same meeting,
 * which is not over); asked again after anything that takes time and before
 * Zoom acts. Without it nobody is admitted. Never rejects.
 */
export async function runArloAction(zoomSdk, action, { zoomRole = null, stillAllowed = null } = {}) {
  try {
    switch (action?.tool) {
      case HAND_TOOLS.chat:
        return await postToChat(zoomSdk, action.args);
      case HAND_TOOLS.admit:
        return await admitFromWaitingRoom(zoomSdk, action.args, zoomRole, stillAllowed);
      default:
        return fail('unsupported');
    }
  } catch {
    return fail('sdk_error');
  }
}
