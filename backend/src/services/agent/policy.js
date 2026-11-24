/**
 * What happens to a request to Arlo: a pure function of five facts the server
 * established itself. Nothing a model wrote, and nothing the asker claims, is
 * an input.
 *
 *   channel    'panel' (typed in someone's Arlo panel) | 'voice' (heard in the transcript)
 *   asker      'owner': an owner typing in their own panel, or a speaker
 *              verified to be an owner (services/agent/speakerMatch.js)
 *              'other': anyone else
 *   whoCanAsk  the meeting's setting: 'owner' | 'anyone'
 *   toolKind   'none' (no tool fits, or the call was not valid)
 *              'read' (answers from what the server holds; changes nothing)
 *              'change' (people in the meeting see an effect)
 *   ownerPanelOpen  true when an owner has Arlo open in the meeting right now
 *              (a spoken request only: a typed one has its own panel)
 *
 * Outcomes:
 *   'run'     do it now. For a tool that changes the meeting this still
 *             depends on typedRequestCovers() below
 *   'sheet'   an owner must see exactly what will be posted or done, and press
 *             the button on their own panel. For a 'read' tool that is spoken
 *             the answer is written first and is what the sheet shows
 *   'answer'  a typed request no tool fits: answered from the meeting's
 *             transcript with the text as typed, as the Ask input always did
 *   'refuse'  a typed request that is not done; the asker is told
 *   'silent'  a spoken request that is not done; nothing is said or shown
 *
 *   panel, owner                 read, change: run          none: answer
 *   panel, other, anyone can ask read: run   change: sheet  none: answer
 *   panel, other, only owners    refuse
 *   voice, no owner's panel open silent (whoever spoke, whatever was asked)
 *   voice, an owner's panel open read, change: sheet        none: silent
 *
 * Nothing spoken is ever done without the sheet: what a spoken request leads
 * to is posted to the meeting chat or changes the meeting, the words came out
 * of a transcript anyone in the meeting can speak into, and a model made the
 * text. That holds for a speaker verified to be an owner and under "anyone can
 * ask" too; who spoke only changes how the sheet words it.
 *
 * A spoken request needs an owner's open panel for everything it could lead
 * to: the sheet is shown on it, and what is approved is posted through it.
 * Without one it is dropped before any model is asked (voiceIsHeard), so no
 * transcript goes to the AI provider for something nobody could see.
 *
 * Anything unknown takes the stricter way: never 'run'.
 */
const { isTicketKey, ticketKeysIn } = require('../../lib/jira');

const ASKERS = new Set(['owner', 'other']);
const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const DOES_SOMETHING = new Set(['read', 'change']);
const TOOL_KINDS = new Set(['none', 'read', 'change']);

/** Whether a spoken request is looked at at all: only while an owner has a panel open. */
function voiceIsHeard(input) {
  return input !== null && typeof input === 'object' && input.ownerPanelOpen === true;
}

/** Whether this person may type a request to Arlo in this meeting at all. */
function panelMayAsk({ asker, whoCanAsk } = {}) {
  if (asker === 'owner') return true;
  return asker === 'other' && whoCanAsk === 'anyone';
}

function decide(input) {
  const {
    channel, asker, whoCanAsk, toolKind, ownerPanelOpen,
  } = input !== null && typeof input === 'object' ? input : {};

  if (channel === 'voice') {
    if (!voiceIsHeard({ ownerPanelOpen })) return 'silent';
    if (!ASKERS.has(asker) || !DOES_SOMETHING.has(toolKind)) return 'silent';
    return 'sheet';
  }

  if (channel === 'panel') {
    if (!ASKERS.has(asker) || !WHO_CAN_ASK.has(whoCanAsk) || !TOOL_KINDS.has(toolKind)) return 'refuse';
    if (!panelMayAsk({ asker, whoCanAsk })) return 'refuse';
    if (toolKind === 'none') return 'answer';
    if (asker === 'owner') return 'run';
    return toolKind === 'read' ? 'run' : 'sheet';
  }

  return 'refuse';
}

// Part of a word: a keyword next to one of these is inside another word
// ("glove", "party_line") or half of a compound ("third-party", "wow-factor")
const BEFORE_WORD = '(?<![\\p{L}\\p{N}_\\-])';
const AFTER_WORD = '(?![\\p{L}\\p{N}_\\-])';
const words = (alternatives, notAfter = '') => new RegExp(`${BEFORE_WORD}${notAfter}(?:${alternatives})${AFTER_WORD}`, 'u');

// A word of the reaction must be in what was typed, as a word of its own, by
// reaction (the names are the tool table's, services/agent/tools.js). Matched
// against plain() text, so lower case only
const REACTION_WORDS = Object.freeze({
  // "thumbs up", "thumb up", "thumbs-up": not "thumbs down", "thumbnail"
  thumbs_up: words('thumbs?[ \\-]up'),
  clap: words('clap|claps|clapping|applause|applaud'),
  heart: words('heart|love', '(?<!broken )'),
  joy: words('laugh|laughing|laughter|joy'),
  tada: words('celebrate|celebration|party|tada', '(?<!third )'),
  open_mouth: words('wow|surprise|surprised'),
});

// "share", "shares", "shared", "sharing" as a word of its own: not "shareholder" or "unshared"
const SHARE_WORD = /(?<![\p{L}\p{N}_])shar(?:e|es|ed|ing)(?![\p{L}\p{N}_])/u;
const SHARE_NOTES_WORD = /(?<![\p{L}\p{N}_])share(?![\p{L}\p{N}_])/u;

// A word that turns a request around ("don't share", "no heart", "stop").
// Anywhere in the text: with one, the owner gets the sheet
const NEGATION = /(?<![\p{L}\p{N}_])(?:not|no|never|stop|without|cannot|dont|\p{L}*n't)(?![\p{L}\p{N}_])/u;

/** Compared without case and with every run of whitespace as one space. */
const folded = (value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * Text as it is read here: NFKC (a full-width "ｍｕｔｅ" is "mute"), without
 * invisible format characters (a soft hyphen or a zero-width space inside
 * "unmute" hides nothing), every apostrophe the plain one, lower case, every
 * run of whitespace one space, trimmed.
 */
const plain = (value) => value.normalize('NFKC')
  .replace(/\p{Cf}/gu, '')
  .replace(/[‘’ʼ′`]/g, '\'')
  .toLowerCase()
  .replace(/\s+/gu, ' ')
  .trim();

// What may stand around a plain request: "Arlo, could you please …" and "…, please."
const POLITE_LEAD = /^(?:arlo,? )?(?:(?:can|could) you )?(?:please )?/u;
const POLITE_TAIL = /^(?:,? please)?[.!]?$/u;

/**
 * Whether the text (plain()) is one of `forms` and nothing else but the
 * polite words around it. A form holds the whole name, so "mute danny lee"
 * is not "mute danny", and "mute danny lee and sam" is not it either.
 */
function isPlainRequest(text, forms) {
  const core = text.replace(POLITE_LEAD, '');
  return forms.some((form) => core.startsWith(form) && POLITE_TAIL.test(core.slice(form.length)));
}

/**
 * Defence in depth for an owner's typed request: whether what a tool that
 * changes the meeting would do is in what the owner typed. A model picked the
 * tool and wrote its arguments; when they are not the owner's own words, the
 * owner gets the sheet like anyone else. When in doubt: the sheet.
 *
 * `typed` is the request as the model that picked the tool got it (cleanLine,
 * services/agent/texts.js), read once more with plain() for everything but
 * the chat message.
 *   post_to_chat             the message appears in the typed text
 *   share_notes              the typed text has the word "share", and no word
 *                            that turns it around (NEGATION: "don't share")
 *   send_reaction            the typed text has a word of that reaction as a
 *                            word of its own (REACTION_WORDS: "thumbs up" for
 *                            thumbs_up, not "thumbnail"; "love" for heart, not
 *                            "glove"), and no NEGATION word
 *   mute_participant         the typed text is "mute <name>" and nothing else:
 *                            the name as a whole, as the tool call has it,
 *                            with "Arlo," / "can you" / "could you" / "please"
 *                            before it and "please", "." or "!" after it at
 *                            most. So "unmute Danny", "don't mute Danny",
 *                            "mute everyone except Danny" and "mute Danny and
 *                            Sam" that a model turned into muting Danny go to
 *                            the sheet
 *   admit_from_waiting_room  the same, for "admit <name>" or "let <name> in",
 *                            each with or without "from the waiting room"
 *   open_ticket              the key is one of the ticket keys in the typed
 *                            text, read the way a key a model gave is read
 *                            (lib/jira.js: "open proj 123" has PROJ-123);
 *                            and when the share dialog would be opened too,
 *                            the typed text has "share" as a word and no
 *                            NEGATION word ("open PROJ-123, don't share")
 *   invite_everyone          never: it shares the notes and sends an
 *                            invitation, and only the sheet says both
 * Any other tool, or anything that is not text: false.
 */
function typedRequestCovers(typed, toolName, args) {
  if (typeof typed !== 'string' || args === null || typeof args !== 'object') return false;
  const text = plain(typed);
  // A name of the tool call as it is compared, or null when there is none
  const nameOf = (value) => (typeof value === 'string' && plain(value).length > 0 ? plain(value) : null);
  if (toolName === 'post_to_chat') {
    const { message } = args;
    return typeof message === 'string' && folded(message).length > 0 && folded(typed).includes(folded(message));
  }
  if (toolName === 'share_notes') return SHARE_NOTES_WORD.test(text) && !NEGATION.test(text);
  if (toolName === 'send_reaction') {
    const { reaction } = args;
    return typeof reaction === 'string' && Object.prototype.hasOwnProperty.call(REACTION_WORDS, reaction)
      && REACTION_WORDS[reaction].test(text) && !NEGATION.test(text);
  }
  if (toolName === 'mute_participant') {
    const name = nameOf(args.name);
    return name !== null && isPlainRequest(text, [`mute ${name}`]);
  }
  if (toolName === 'admit_from_waiting_room') {
    const name = nameOf(args.name);
    return name !== null && isPlainRequest(text, [
      `admit ${name} from the waiting room`, `let ${name} in from the waiting room`, `admit ${name}`, `let ${name} in`,
    ]);
  }
  if (toolName === 'open_ticket') {
    const { key, share } = args;
    if (!isTicketKey(key) || typeof share !== 'boolean') return false;
    return ticketKeysIn(typed).includes(key) && (share === false || (SHARE_WORD.test(text) && !NEGATION.test(text)));
  }
  return false;
}

module.exports = {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers,
};
