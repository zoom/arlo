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
const { isTimerMinutes } = require('./texts');

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
// The same without "stop", for the one request that is a stop ("stop the timer")
const NEGATION_BUT_STOP = /(?<![\p{L}\p{N}_])(?:not|no|never|without|cannot|dont|\p{L}*n't)(?![\p{L}\p{N}_])/u;

const TIMER_WORD = words('timer');
const STOP_TIMER_WORD = words('stop|cancel|end');

// The number words a timer's minutes are read from. A small table on purpose:
// any other amount is typed as digits, or the owner gets the sheet
const MINUTE_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, 'forty-five': 45, 'forty five': 45, sixty: 60, ninety: 90,
});
// "5 minutes", "5-minute", "five min": a number of the table or up to three
// digits, then the unit. Not the end of a longer number ("twenty five", "a
// hundred and five", "1.5"): what stands before it must not be part of one
const MINUTES_SAID = new RegExp(
  '(?<![\\p{L}\\p{N}_.,\\-])(?<!(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and|point)[ \\-])'
  + `(\\d{1,3}|${Object.keys(MINUTE_WORDS).sort((a, b) => b.length - a.length).join('|')})[ \\-]?(?:min|mins|minute|minutes)${AFTER_WORD}`,
  'gu',
);
// A unit of time that is left when the amounts above are taken out: an amount
// that was not read ("twenty five minutes", "1.5 minutes", "a minute"), or one
// in another unit
const OTHER_AMOUNT = words('mins?|minutes?|hours?|hrs?|seconds?|secs?');

/**
 * Every length of time in the text (plain()), in minutes, in the order read:
 * "5 minutes", "five minute", "an hour" (60), "half an hour" (30). An amount
 * that cannot be read for sure (hours, seconds, "twenty five minutes", "1.5
 * minutes", "a minute") is NaN, which equals no number: with one in the text nothing is
 * covered.
 */
function minutesIn(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  let rest = text.replace(/(?<![\p{L}\p{N}_])half an hour(?![\p{L}\p{N}_]| and)/gu, () => { found.push(30); return ' | '; });
  rest = rest.replace(/(?<![\p{L}\p{N}_])an hour(?![\p{L}\p{N}_]| and)/gu, () => { found.push(60); return ' | '; });
  rest = rest.replace(MINUTES_SAID, (all, amount) => {
    found.push(/^\d/.test(amount) ? Number(amount) : MINUTE_WORDS[amount]);
    return ' | ';
  });
  if (OTHER_AMOUNT.test(rest)) found.push(NaN);
  return found;
}

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
 *   set_timer                the typed text has the word "timer", no NEGATION
 *                            word, and a length of time that is exactly the
 *                            tool call's minutes: digits or a number word of
 *                            MINUTE_WORDS with "minute(s)" or "min(s)", "an
 *                            hour" (60) or "half an hour" (30). Two different
 *                            lengths, hours, seconds or a number that is not
 *                            read for sure ("twenty five minutes"): the sheet
 *   stop_timer               the typed text has "stop", "cancel" or "end" and
 *                            "timer" as words of their own, and no other word
 *                            that turns it around ("don't stop the timer")
 *   invite_everyone          never: it shares the notes and sends an
 *                            invitation, and only the sheet says both
 *   open_notes_for_everyone  never: it shares the notes and shows the owner's
 *                            Arlo view to the whole meeting, and only the
 *                            sheet says so
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
  if (toolName === 'set_timer') {
    const { minutes } = args;
    if (!isTimerMinutes(minutes) || !TIMER_WORD.test(text) || NEGATION.test(text)) return false;
    const said = minutesIn(text);
    return said.length > 0 && said.every((one) => one === minutes);
  }
  if (toolName === 'stop_timer') return STOP_TIMER_WORD.test(text) && TIMER_WORD.test(text) && !NEGATION_BUT_STOP.test(text);
  return false;
}

module.exports = {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers, minutesIn,
};
