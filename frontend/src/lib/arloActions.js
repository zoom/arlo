/**
 * The panel as Arlo's hands: what Arlo can only do through the Zoom Apps SDK.
 * The server decides what is done and sends it to one owner's panel as an
 * action ({ tool, args }); the panel runs it here and reports
 * { ok: true } or { ok: false, code }.
 *
 *   post_to_chat             { message }   into the meeting chat, for everyone
 *   admit_from_waiting_room  { name }      host or co-host only
 *   invite_everyone          {}            the app invitation, to everyone in the meeting
 *   send_reaction            { reaction }  one of REACTIONS, as this person's own reaction
 *   mute_participant         { name }      host or co-host only; mutes, never unmutes
 *   open_ticket              { url, key, share }  the ticket in the system browser, then
 *                                          Zoom's share dialog when `share` is true
 *
 * Codes: 'unsupported' (not a tool of this panel, arguments it cannot use, a
 * Zoom client without the API, or muting the person whose panel this is:
 * Zoom's call does not act on its caller), 'not_allowed' (this person's Zoom
 * role may not, or this panel may no longer act for Arlo), 'not_found' (nobody
 * there by that name), 'several_match' (more than one person has that exact
 * name, or the name is only the first word of someone's: Arlo then asks for
 * the full name), 'sdk_error' (Zoom refused or failed), 'share_failed' (the
 * ticket was opened in the browser and the share dialog was not).
 *
 * A ticket's URL is never taken as it comes: this panel builds it again from
 * the deployment's Jira base URL (the server's settings, given as
 * `jiraBaseUrl`), "/browse/" and the key, and opens it only when the two are
 * the same text. Zoom's SDK cannot pick the window that is shared: the share
 * dialog opens and this person picks the browser.
 *
 * Only the person the owner approved is admitted or muted: the sheet named
 * them, so the name must be someone's whole name, and exactly one person's.
 *
 * The arguments are checked again here although the server checked them: this
 * is the last step before Zoom acts. Nothing is logged: a message, a name and
 * Zoom's error text are meeting content.
 */
export const HAND_TOOLS = Object.freeze({
  chat: 'post_to_chat',
  admit: 'admit_from_waiting_room',
  invite: 'invite_everyone',
  reaction: 'send_reaction',
  mute: 'mute_participant',
  ticket: 'open_ticket',
});

/**
 * The reactions Arlo can send, by the server's name for each. The emoji is
 * this table's, never the server's: nothing else reaches Zoom.
 * SetEmojiReactionOptions takes one of `emoji`, `name` or `unicode` (error
 * 10156 when several are given and disagree), so only `emoji` is passed. The
 * docs do not list the emoji a meeting accepts (getEmojiConfiguration does,
 * per client) or say whether the heart is written with its variation selector
 * (U+FE0F); it is here, as Zoom's own example writes emoji in full. One Zoom
 * does not take is refused by Zoom (10155) and reported as 'sdk_error'.
 */
export const REACTIONS = Object.freeze({
  thumbs_up: '\u{1F44D}',
  clap: '\u{1F44F}',
  heart: '\u2764\uFE0F',
  joy: '\u{1F602}',
  tada: '\u{1F389}',
  open_mouth: '\u{1F62E}',
});

// Who may let people in from the waiting room (Zoom's rule for both APIs)
const MAY_ADMIT = new Set(['host', 'coHost']);
// Who may mute someone else (Zoom's rule for getMeetingParticipants and
// toggleParticipantMediaAudio)
const MAY_MUTE = MAY_ADMIT;
/**
 * ToggleParticipantMediaAudioOptions.audio: "true = unmute, false = mute".
 * The only value this file ever passes: Arlo never unmutes anyone.
 */
const MUTE = false;
// "Arlo: " and an answer of up to 500 characters
const MAX_MESSAGE_CHARS = 510;
const MAX_NAME_CHARS = 100;
// More people than this in a waiting room, or in a meeting, are not looked through
const MAX_WAITING = 1000;
const MAX_PARTICIPANTS = 1000;

// A ticket key as the server rebuilds it (backend lib/jira.js): a project of
// 2 to 10 letters and digits that starts with a letter, a dash, a number
const TICKET_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const MAX_TICKET_URL_CHARS = 300;
const MAX_JIRA_BASE_CHARS = 200;

const ok = Object.freeze({ ok: true });
const fail = (code) => ({ ok: false, code });
const has = (zoomSdk, method) => typeof zoomSdk?.[method] === 'function';

/** An https URL without user name or password, or null: parsed, never matched by eye. */
function httpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hostname !== '' ? parsed : null;
}

/**
 * The deployment's Jira base URL as the server's settings give it
 * (`features.jira.baseUrl`), or null when it is not one in exactly the form
 * the server keeps: https, a host, an optional path, no trailing slash, no
 * user name, password, query or fragment.
 */
export function jiraBaseOf(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_JIRA_BASE_CHARS) return null;
  if (!/^[\x21-\x7E]+$/.test(value) || /[\\?#@]/.test(value)) return null;
  const parsed = httpsUrl(value);
  if (parsed === null || parsed.search !== '' || parsed.hash !== '') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` === value ? value : null;
}

/**
 * What this panel tells the server it can do (`arlo.hands`): the chat, the
 * invitation and a reaction when the client accepted each; the waiting room
 * and muting when the client accepted their APIs and Zoom says this person is
 * the host or a co-host; a ticket when the client opens URLs and the
 * deployment has a Jira (the share dialog is not needed to announce it: a
 * ticket can be opened without it). At most six names (the server takes ten).
 */
export function handsFor({
  chatSupported, waitingRoomSupported, invitationSupported, reactionSupported, muteSupported, openUrlSupported, jiraBaseUrl, zoomRole,
}) {
  const can = [];
  if (chatSupported === true) can.push(HAND_TOOLS.chat);
  if (waitingRoomSupported === true && MAY_ADMIT.has(zoomRole)) can.push(HAND_TOOLS.admit);
  if (invitationSupported === true) can.push(HAND_TOOLS.invite);
  if (reactionSupported === true) can.push(HAND_TOOLS.reaction);
  if (muteSupported === true && MAY_MUTE.has(zoomRole)) can.push(HAND_TOOLS.mute);
  if (openUrlSupported === true && jiraBaseOf(jiraBaseUrl) !== null) can.push(HAND_TOOLS.ticket);
  return can;
}

/** A name for comparing: NFC, no case, single spaces. */
const comparable = (value) => (
  typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() : ''
);

const isEmptyObject = (value) => (
  typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
);

/**
 * The one person in Zoom's list ({ participants: [{ screenName,
 * participantUUID }] }, the first `max` of them) whose whole name is `asked`
 * (already comparable): { participantUUID }, or { code } when there is not
 * exactly one, the list is not one, or Zoom gave that person no UUID.
 */
function theOneNamed(answer, asked, max) {
  if (!Array.isArray(answer?.participants)) return { code: 'sdk_error' };
  const people = answer.participants.slice(0, max)
    .map((person) => ({ name: comparable(person?.screenName), participantUUID: person?.participantUUID }))
    .filter((person) => person.name !== '');

  // The whole name, and exactly one person by it. A first name alone is
  // nobody: the owner approved "Sam", not whoever's name starts with it.
  const matches = people.filter((person) => person.name === asked);
  if (matches.length > 1) return { code: 'several_match' };
  if (matches.length === 0) {
    return { code: people.some((person) => person.name.split(' ')[0] === asked) ? 'several_match' : 'not_found' };
  }
  const { participantUUID } = matches[0];
  if (typeof participantUUID !== 'string' || participantUUID.length === 0) return { code: 'sdk_error' };
  return { participantUUID };
}

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
  const found = theOneNamed(answer, asked, MAX_WAITING);
  if (found.code) return fail(found.code);
  await zoomSdk.admitParticipantFromWaitingRoom({ participantUUID: found.participantUUID });
  return ok;
}

async function inviteEveryone(zoomSdk, args) {
  // Nothing is asked with it: arguments would be something nobody approved
  if (args !== undefined && args !== null && !isEmptyObject(args)) return fail('unsupported');
  if (!has(zoomSdk, 'sendAppInvitationToAllParticipants')) return fail('unsupported');
  await zoomSdk.sendAppInvitationToAllParticipants();
  return ok;
}

async function sendReaction(zoomSdk, args) {
  const reaction = args?.reaction;
  if (typeof reaction !== 'string' || !Object.prototype.hasOwnProperty.call(REACTIONS, reaction)) return fail('unsupported');
  if (!has(zoomSdk, 'setEmojiReaction')) return fail('unsupported');
  await zoomSdk.setEmojiReaction({ emoji: REACTIONS[reaction] });
  return ok;
}

async function muteParticipant(zoomSdk, args, zoomRole, stillAllowed, selfParticipantUUID) {
  // The name and nothing else: this call has an "unmute" and an "everyone",
  // and neither can be asked for here
  if (args === null || typeof args !== 'object' || Object.keys(args).some((key) => key !== 'name')) return fail('unsupported');
  const asked = typeof args.name === 'string' && args.name.length <= MAX_NAME_CHARS ? comparable(args.name) : '';
  if (asked === '') return fail('unsupported');
  if (!has(zoomSdk, 'getMeetingParticipants') || !has(zoomSdk, 'toggleParticipantMediaAudio')) return fail('unsupported');
  if (!MAY_MUTE.has(zoomRole)) return fail('not_allowed');

  const answer = await zoomSdk.getMeetingParticipants();
  // As for the waiting room: the list took a while
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');
  const found = theOneNamed(answer, asked, MAX_PARTICIPANTS);
  if (found.code) return fail(found.code);
  // Zoom's docs: the call "doesn't affect the person initiating the request",
  // and their own UUID in the list is error 10108. Not tried.
  if (typeof selfParticipantUUID === 'string' && found.participantUUID === selfParticipantUUID) return fail('unsupported');
  // Always exactly one UUID: with an empty list Zoom mutes everyone
  await zoomSdk.toggleParticipantMediaAudio({ participantUUIDs: [found.participantUUID], audio: MUTE });
  return ok;
}

async function openTicket(zoomSdk, args, stillAllowed, jiraBaseUrl) {
  // Exactly these three: anything else is something nobody approved
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('unsupported');
  const keys = Object.keys(args);
  if (keys.length !== 3 || !['url', 'key', 'share'].every((name) => keys.includes(name))) return fail('unsupported');
  const { url, key, share } = args;
  if (typeof share !== 'boolean' || typeof key !== 'string' || !TICKET_KEY.test(key)) return fail('unsupported');
  if (typeof url !== 'string' || url.length > MAX_TICKET_URL_CHARS) return fail('unsupported');
  // The one URL this panel opens: the deployment's base, "/browse/", the key.
  // Built here again and compared as text; it must also parse as plain https
  const base = jiraBaseOf(jiraBaseUrl);
  if (base === null || httpsUrl(url) === null || url !== `${base}/browse/${key}`) return fail('unsupported');
  if (!has(zoomSdk, 'openUrl')) return fail('unsupported');
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');

  // OpenUrlOptions is { url } and nothing else. Zoom opens it in the system
  // browser; a domain that is not on the app's Marketplace allowlist is
  // refused (10015), which is 'sdk_error' here
  await zoomSdk.openUrl({ url });
  if (!share) return ok;

  // From here the ticket is open: whatever keeps the share dialog from
  // coming up is 'share_failed', never a plain failure
  if (!has(zoomSdk, 'promptShareScreen') || stillAllowed() !== true) return fail('share_failed');
  try {
    // No options: PromptShareScreenOptions has only shareToBreakoutRooms,
    // shareSound and optimizeForVideoClip, all false by default. The person
    // picks what is shared in Zoom's dialog; the SDK cannot pick a window
    await zoomSdk.promptShareScreen();
  } catch {
    return fail('share_failed');
  }
  return ok;
}

/**
 * Run one action with the Zoom Apps SDK. `zoomRole`: this person's role in
 * the Zoom meeting, as Zoom reports it. `stillAllowed()`: true while this
 * panel may still act for Arlo (an owner's, signed in, in the same meeting,
 * which is not over); asked again after anything that takes time and before
 * Zoom acts. Without it nobody is admitted or muted and nothing is opened. `selfParticipantUUID`:
 * this person's participant UUID in the meeting, when Zoom gave one.
 * `jiraBaseUrl`: the deployment's Jira base URL from the server's settings;
 * without it no ticket is opened. Never rejects.
 */
export async function runArloAction(zoomSdk, action, {
  zoomRole = null, stillAllowed = null, selfParticipantUUID = null, jiraBaseUrl = null,
} = {}) {
  try {
    switch (action?.tool) {
      case HAND_TOOLS.chat:
        return await postToChat(zoomSdk, action.args);
      case HAND_TOOLS.admit:
        return await admitFromWaitingRoom(zoomSdk, action.args, zoomRole, stillAllowed);
      case HAND_TOOLS.invite:
        return await inviteEveryone(zoomSdk, action.args);
      case HAND_TOOLS.reaction:
        return await sendReaction(zoomSdk, action.args);
      case HAND_TOOLS.mute:
        return await muteParticipant(zoomSdk, action.args, zoomRole, stillAllowed, selfParticipantUUID);
      case HAND_TOOLS.ticket:
        return await openTicket(zoomSdk, action.args, stillAllowed, jiraBaseUrl);
      default:
        return fail('unsupported');
    }
  } catch {
    return fail('sdk_error');
  }
}
