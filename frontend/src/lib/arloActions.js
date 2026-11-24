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
 *   set_timer                { minutes }   a countdown on Zoom's Dynamic Indicator, for everyone
 *   stop_timer               {}            takes it down again
 *   open_notes_for_everyone  {}            Zoom's Collaborate mode: Arlo opens for everyone in
 *                                          the meeting, with this person's Arlo view as a screen
 *                                          share for people without the app
 *
 * Codes: 'unsupported' (not a tool of this panel, arguments it cannot use, a
 * Zoom client without the API, or muting the person whose panel this is:
 * Zoom's call does not act on its caller), 'not_allowed' (this person's Zoom
 * role may not, or this panel may no longer act for Arlo), 'not_found' (nobody
 * there by that name), 'several_match' (more than one person has that name,
 * the name is how someone else's begins, or it mixes look-alike scripts: Arlo
 * then asks for the full name), 'sdk_error' (Zoom refused or failed, or the
 * list of people is longer than is looked through), 'share_failed' (the
 * ticket was opened in the browser and the share dialog was not).
 *
 * Opening the notes for everyone: the server has shared the notes before it
 * asks. Collaborate is started with the screen share (lib/collaborate.js,
 * where what is guessed about that API is kept). When Zoom refuses (the
 * feature is off for the app, a webinar or a breakout room, an older client)
 * that is 'sdk_error' and nothing is done in its place: the owner agreed to
 * "open the notes for everyone", and the sheet said nothing of an invitation.
 *
 * A ticket's URL is never taken as it comes: this panel builds it again from
 * the deployment's Jira base URL (the server's settings, given as
 * `jiraBaseUrl`), "/browse/" and the key, and opens it only when the two are
 * the same text. Zoom's SDK cannot pick the window that is shared: the share
 * dialog opens and this person picks the browser.
 *
 * A timer is Zoom's own countdown on the Dynamic Indicator. What is sent for
 * it (the unit of `timer.start`, the text beside it) is a guess, kept with
 * the other guesses about that API in lib/dynamicIndicator.js
 * (INDICATOR_GUESSES). The text is fixed: nothing of the request is shown.
 * The panel's own record of the timer (lib/indicatorTimer.js, given as
 * `indicatorTimer`) is started before Zoom is asked: from then on the hook
 * that keeps Arlo's status on the indicator sends nothing that might end the
 * countdown, and it puts the status back when the timer is over. Stopping
 * removes the indicator (the one call that surely ends a countdown) and
 * tells that record, so the panel that owns the status sets it again.
 *
 * Only the person the owner approved is admitted or muted: the sheet named
 * them, so the name must be someone's whole name, and exactly one person's
 * (theOneNamed below says what "the same name" is, and when it is not sure).
 *
 * The arguments are checked again here although the server checked them: this
 * is the last step before Zoom acts. Nothing is logged: a message, a name and
 * Zoom's error text are meeting content.
 */
import { INDICATOR_GUESSES } from './dynamicIndicator';
import { isTimerMinutes } from './indicatorTimer';
import { startCollaborateForEveryone } from './collaborate';

export const HAND_TOOLS = Object.freeze({
  chat: 'post_to_chat',
  admit: 'admit_from_waiting_room',
  invite: 'invite_everyone',
  reaction: 'send_reaction',
  mute: 'mute_participant',
  ticket: 'open_ticket',
  setTimer: 'set_timer',
  stopTimer: 'stop_timer',
  openNotes: 'open_notes_for_everyone',
});

/**
 * The reactions Arlo can send, by the server's name for each. The emoji is
 * this table's, never the server's: nothing else reaches Zoom.
 * SetEmojiReactionOptions takes one of `emoji`, `name` or `unicode` (error
 * 10156 when several are given and disagree), so only `emoji` is passed. The
 * docs do not list the emoji a meeting accepts or say whether the heart is
 * written with its variation selector (U+FE0F); it is here, as Zoom's own
 * example writes emoji in full. One Zoom does not take is refused by Zoom
 * (10155) and reported as 'sdk_error'.
 *
 * The server has the same table (backend/src/services/agent/texts.js,
 * REACTIONS) for the sheet's words; a test on each side holds its table to
 * the same literal.
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
// A waiting room, or a meeting, of more people than this is not looked through
// at all: a match in a part of the list says nothing about the rest
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
 * ticket can be opened without it); a timer, to start and to stop, when the
 * client accepted the Dynamic Indicator APIs; opening the notes for everyone
 * when the client accepted startCollaborate (whether Zoom then starts it is
 * only known when it is tried). At most nine names (the server takes ten).
 */
export function handsFor({
  chatSupported, waitingRoomSupported, invitationSupported, reactionSupported, muteSupported, openUrlSupported, jiraBaseUrl,
  indicatorSupported, collaborateSupported, zoomRole,
}) {
  const can = [];
  if (chatSupported === true) can.push(HAND_TOOLS.chat);
  if (waitingRoomSupported === true && MAY_ADMIT.has(zoomRole)) can.push(HAND_TOOLS.admit);
  if (invitationSupported === true) can.push(HAND_TOOLS.invite);
  if (reactionSupported === true) can.push(HAND_TOOLS.reaction);
  if (muteSupported === true && MAY_MUTE.has(zoomRole)) can.push(HAND_TOOLS.mute);
  if (openUrlSupported === true && jiraBaseOf(jiraBaseUrl) !== null) can.push(HAND_TOOLS.ticket);
  if (indicatorSupported === true) can.push(HAND_TOOLS.setTimer, HAND_TOOLS.stopTimer);
  if (collaborateSupported === true) can.push(HAND_TOOLS.openNotes);
  return can;
}

/**
 * A name for comparing: NFKC (a full-width letter or a ligature is the letter
 * it stands for), without format characters (zero-width space and joiners,
 * soft hyphen, direction marks: nobody sees them, so they make no other
 * name), no case, single spaces. Two names that are equal after this are one
 * name to the person who reads them. Every apostrophe is the plain one
 * ("O’Brien" is "O'Brien"), the same set the server folds when it reads a
 * typed request (backend services/agent/policy.js `plain`).
 */
export const comparable = (value) => (
  typeof value === 'string'
    ? value.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[‘’ʼ′`]/g, '\'').toLowerCase().replace(/\s+/gu, ' ')
      .trim()
    : ''
);

const LATIN = /\p{Script=Latin}/u;
const LOOKS_LATIN = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
/**
 * Whether a word of the name has Latin letters next to Cyrillic or Greek
 * ones ("Dаnny" with a Cyrillic а): it reads as another name than it is, and
 * no normalization tells them apart. A name wholly in one script, or with one
 * script per word, is not that. (A name written wholly in look-alike letters
 * of another script is not caught here.)
 */
const mixesScripts = (name) => name.split(/[^\p{L}\p{M}]+/u).some((word) => LATIN.test(word) && LOOKS_LATIN.test(word));

const isEmptyObject = (value) => (
  typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
);

/**
 * The one person in Zoom's list ({ participants: [{ screenName,
 * participantUUID }] }) whose whole name is `asked` (already comparable):
 * { participantUUID }, or { code } when it is not sure who is meant:
 *   'sdk_error'      the list is not one, has more than `max` people (it is
 *                    not looked through in part), or Zoom gave that person no UUID
 *   'several_match'  more than one person has that name; or someone else's
 *                    name begins with it as whole words ("Danny" while "Danny"
 *                    and "Danny Lee" are both there, or only "Danny Lee" is);
 *                    or the name mixes look-alike scripts in a word
 *   'not_found'      nobody has it
 */
function theOneNamed(answer, asked, max) {
  if (!Array.isArray(answer?.participants) || answer.participants.length > max) return { code: 'sdk_error' };
  // A name that reads as another one than it is: nobody is picked by it
  if (mixesScripts(asked)) return { code: 'several_match' };
  const people = answer.participants
    .map((person) => ({ name: comparable(person?.screenName), participantUUID: person?.participantUUID }))
    .filter((person) => person.name !== '');

  // The whole name, and exactly one person by it. A first name alone is
  // nobody: the owner approved "Sam", not whoever's name starts with it, and
  // not "Sam" when a "Sam Stranger" is there too.
  const matches = people.filter((person) => person.name === asked);
  if (matches.length > 1 || people.some((person) => person.name.startsWith(`${asked} `))) return { code: 'several_match' };
  if (matches.length === 0) return { code: 'not_found' };
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

const isTimer = (value) => value !== null && typeof value === 'object'
  && typeof value.start === 'function' && typeof value.end === 'function';

async function setTimer(zoomSdk, args, stillAllowed, indicatorTimer) {
  // The minutes and nothing else: no text, no sound, no option of Zoom's comes with the request
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('unsupported');
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'minutes' || !isTimerMinutes(args.minutes)) return fail('unsupported');
  if (!has(zoomSdk, 'setDynamicIndicator') || !isTimer(indicatorTimer)) return fail('unsupported');
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');

  // From here on the status hook sends nothing: a status text might end the countdown
  if (indicatorTimer.start(args.minutes) !== true) return fail('unsupported');
  try {
    await zoomSdk.setDynamicIndicator({
      text: INDICATOR_GUESSES.timerText,
      timer: {
        action: 'start',
        direction: 'down',
        // A guess: `timer.start` in seconds (INDICATOR_GUESSES in lib/dynamicIndicator.js)
        start: args.minutes * INDICATOR_GUESSES.timerStartPerMinute,
        showNotification: true,
        withSound: false,
      },
    });
  } catch {
    // No countdown: the status goes back on the indicator
    indicatorTimer.end('failed');
    return fail('sdk_error');
  }
  return ok;
}

async function stopTimer(zoomSdk, args, stillAllowed, indicatorTimer) {
  if (args !== undefined && args !== null && !isEmptyObject(args)) return fail('unsupported');
  if (!has(zoomSdk, 'removeDynamicIndicator') || !isTimer(indicatorTimer)) return fail('unsupported');
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');
  // Removing the indicator ends whatever countdown is on it. `timer: { action:
  // 'end' }` might do it and keep the text, but whether it needs a text, and
  // what it leaves, is not documented. When Zoom refuses, the timer is left
  // as it is ('sdk_error', below)
  await zoomSdk.removeDynamicIndicator();
  // Told also when this panel knows of no timer: the indicator is gone, and
  // the panel that owns Arlo's status sets it again
  indicatorTimer.end('stopped');
  return ok;
}

async function openNotesForEveryone(zoomSdk, args, stillAllowed) {
  // Nothing is asked with it: an option of Zoom's would be something nobody approved
  if (args !== undefined && args !== null && !isEmptyObject(args)) return fail('unsupported');
  if (!has(zoomSdk, 'startCollaborate')) return fail('unsupported');
  if (typeof stillAllowed !== 'function' || stillAllowed() !== true) return fail('not_allowed');

  // Zoom did not start Collaborate: nothing is done in its place. The owner
  // agreed to opening the notes, not to an invitation
  return (await startCollaborateForEveryone(zoomSdk)) ? ok : fail('sdk_error');
}

/**
 * Run one action with the Zoom Apps SDK. `zoomRole`: this person's role in
 * the Zoom meeting, as Zoom reports it. `stillAllowed()`: true while this
 * panel may still act for Arlo (an owner's, signed in, in the same meeting,
 * which is not over); asked again after anything that takes time and before
 * Zoom acts. Without it nobody is admitted or muted and nothing is opened. `selfParticipantUUID`:
 * this person's participant UUID in the meeting, when Zoom gave one.
 * `jiraBaseUrl`: the deployment's Jira base URL from the server's settings;
 * without it no ticket is opened. `indicatorTimer`: this panel's record of a
 * countdown it started (lib/indicatorTimer.js); without it no timer is
 * started or stopped. Never rejects.
 */
export async function runArloAction(zoomSdk, action, {
  zoomRole = null, stillAllowed = null, selfParticipantUUID = null, jiraBaseUrl = null, indicatorTimer = null,
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
      case HAND_TOOLS.setTimer:
        return await setTimer(zoomSdk, action.args, stillAllowed, indicatorTimer);
      case HAND_TOOLS.stopTimer:
        return await stopTimer(zoomSdk, action.args, stillAllowed, indicatorTimer);
      case HAND_TOOLS.openNotes:
        return await openNotesForEveryone(zoomSdk, action.args, stillAllowed);
      default:
        return fail('unsupported');
    }
  } catch {
    return fail('sdk_error');
  }
}
