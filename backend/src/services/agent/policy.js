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
const { isIssueNumber, onlyIssueIn } = require('../../lib/github');
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

// The emoji of each reaction (the same six as REACTIONS in services/agent/
// texts.js; the heart with or without its variation selector): typing the
// emoji itself asks for that reaction
const REACTION_EMOJI = Object.freeze({
  thumbs_up: '\u{1F44D}',
  clap: '\u{1F44F}',
  heart: '❤',
  joy: '\u{1F602}',
  tada: '\u{1F389}',
  open_mouth: '\u{1F62E}',
});

// "share" or "sharing" as a word of its own, or as "screen share", "screen-share",
// "screenshare": not "shared" (a shared drive), "shareholder", "un-share"
const SHARE_WORD = /(?<![\p{L}\p{N}_-])(?:share|sharing)(?![\p{L}\p{N}_-])|(?<![\p{L}\p{N}_-])screen[ -]?(?:share|sharing)(?![\p{L}\p{N}_-])/u;
// What opening an issue is asked with
const OPEN_WORD = words('open|pull up|bring up|show');

// A word that turns a request around ("don't share", "no heart", "stop",
// "unless", "instead"). Anywhere in the text: with one, the owner gets the sheet
const NEGATION = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:not|no|never|stop|without|cannot|dont|cant|wont|shouldnt|wouldnt|couldnt|doesnt|didnt|isnt|arent|wasnt'
  + '|avoid|skip|unless|instead|rather|nobody|nothing|none|neither|nor|\\p{L}*n\'t)(?![\\p{L}\\p{N}_])',
  'u',
);

const TIMER_WORD = words('timer');
// A timer is started with one of these, or asked for in the bare form below
const START_TIMER_WORD = words('set|start|put|give');
// With one of these the request is about a timer that runs, or about not starting one
const NOT_A_START = words('cancel|end|skip|add|extend|remove|pause|restart|left|stop');

// The number words a timer's minutes are read from. A small table on purpose:
// any other amount is typed as digits, or the owner gets the sheet
const MINUTE_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, 'forty-five': 45, 'forty five': 45, sixty: 60, ninety: 90,
});
const NUMBER = `\\d{1,3}|${Object.keys(MINUTE_WORDS).sort((x, y) => y.length - x.length).join('|')}`;
// "5 minutes", "5-minute", "five min", "2 hours": a number of the table or up
// to three digits, then the unit. Not the end of a longer number ("twenty
// five", "a hundred and five", "1.5", "1 5"): what stands before it must not
// be part of one
const NOT_AFTER_NUMBER = '(?<![\\p{L}\\p{N}_.,\\-])(?<!\\d )(?<!(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and|point)[ \\-])';
const MINUTES_SAID = new RegExp(`${NOT_AFTER_NUMBER}(${NUMBER})[ \\-]?(?:min|mins|minute|minutes)${AFTER_WORD}`, 'gu');
// Whole hours, and nothing that goes on ("an hour and a half")
const HOURS_SAID = new RegExp(`${NOT_AFTER_NUMBER}(${NUMBER})[ \\-]?(?:hour|hours)${AFTER_WORD}(?! and)`, 'gu');
// A unit of time that is left when the amounts above are taken out: an amount
// that was not read ("twenty five minutes", "1.5 minutes", "a minute"), or one
// in another unit
const OTHER_AMOUNT = words('mins?|minutes?|hours?|hrs?|seconds?|secs?');
const MAX_TIMER_MINUTES = 120;

// The bare form of asking for a timer, without a verb: "5 minute timer",
// "a ten minute timer", "timer for 5 minutes", "timer 5 minutes"
const AMOUNT = `(?:(?:${NUMBER})[ \\-]?(?:min|mins|minute|minutes|hour|hours)|half an hour|an hour)`;
const BARE_TIMER = new RegExp(`^(?:(?:(?:a|an) )?${AMOUNT} timer|timer(?: for)? ${AMOUNT})$`, 'u');

/**
 * Every length of time in the text (plain()), in minutes, in the order read:
 * "5 minutes", "five minute", "an hour" (60), "half an hour" (30), "2 hours"
 * (120). An amount that cannot be read for sure (more than two hours,
 * seconds, "twenty five minutes", "1.5 minutes", "a minute", "timer 1 5
 * minutes", "an hour and a half") is NaN, which equals no number: with one in
 * the text nothing is covered.
 */
function minutesIn(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  const numberOf = (amount) => (/^\d/.test(amount) ? Number(amount) : MINUTE_WORDS[amount]);
  let rest = text.replace(/(?<![\p{L}\p{N}_])half an hour(?![\p{L}\p{N}_]| and)/gu, () => { found.push(30); return ' | '; });
  rest = rest.replace(/(?<![\p{L}\p{N}_])an hour(?![\p{L}\p{N}_]| and)/gu, () => { found.push(60); return ' | '; });
  rest = rest.replace(HOURS_SAID, (all, amount) => {
    const minutes = numberOf(amount) * 60;
    found.push(minutes <= MAX_TIMER_MINUTES ? minutes : NaN);
    return ' | ';
  });
  rest = rest.replace(MINUTES_SAID, (all, amount) => {
    found.push(numberOf(amount));
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

// What may stand around a plain request: "Hey Arlo, could you please …" and
// "…, please." A question mark only after "can you", "could you", "would you"
const POLITE_LEAD = /^(?:(?:hey )?arlo,? )?(?:(can|could|would) you )?(?:please )?/u;
const POLITE_TAIL = /^(?:,? please)?[.!]?$/u;
const POLITE_TAIL_ASKED = /^(?:,? please)?[.!?]?$/u;

/** The text without the polite words before it, and whether it began as "can you …". */
function withoutLead(text) {
  const lead = POLITE_LEAD.exec(text);
  return { core: text.slice(lead[0].length), asked: lead[1] !== undefined };
}
/** Whether `rest` is nothing but the polite words that may end a request. */
const isPoliteTail = (rest, asked) => (asked ? POLITE_TAIL_ASKED : POLITE_TAIL).test(rest);

/**
 * Whether the text (plain()) is one of `forms` and nothing else but the
 * polite words around it. A form holds the whole name, so "mute danny lee"
 * is not "mute danny", and "mute danny lee and sam" is not it either.
 */
function isPlainRequest(text, forms) {
  const { core, asked } = withoutLead(text);
  return forms.some((form) => core.startsWith(form) && isPoliteTail(core.slice(form.length), asked));
}

// The whole of a request to share the notes
const SHARE_NOTES_FORMS = Object.freeze(
  ['share the notes', 'share notes', 'share arlo\'s notes', 'share my notes']
    .flatMap((form) => ['', ' with everyone', ' with everybody', ' with the meeting', ' with all'].map((tail) => `${form}${tail}`)),
);
const STOP_TIMER_FORMS = Object.freeze(['stop', 'cancel', 'end'].flatMap((verb) => [`${verb} the timer`, `${verb} timer`]));

// Where the message stood in a typed request to post it: a character that is
// in no cleaned text
const MESSAGE_PLACE = '\u0001';
const CHAT_PLACE = '(?:in|to|into) (?:the )?(?:meeting )?chat';
// "post <message>", "write this in the chat: <message>", "say "<message>" to
// the meeting chat": a verb, the chat before or after the message, and nothing else
const POST_FRAME = new RegExp(
  `^(?:post|write|send|say|put)(?: (?:this|that))?( ${CHAT_PLACE})?[:,]? ?["'“«]?${MESSAGE_PLACE}["'”»]?( ${CHAT_PLACE})?`,
  'u',
);

/**
 * Whether a typed request is nothing but "post <message>": the message once,
 * a verb before it, the chat named before or after it at most once, and the
 * polite words. "don't post hello", "what does hello mean" and "post hello
 * and then delete hello" are not.
 */
function isPlainPost(typed, message) {
  if (typeof message !== 'string' || typed.includes(MESSAGE_PLACE)) return false;
  const all = folded(typed);
  const wanted = folded(message);
  if (wanted.length === 0) return false;
  const at = all.indexOf(wanted);
  if (at === -1 || all.indexOf(wanted, at + 1) !== -1) return false;
  const around = plain(`${all.slice(0, at)}${MESSAGE_PLACE}${all.slice(at + wanted.length)}`);
  const { core, asked } = withoutLead(around);
  const frame = POST_FRAME.exec(core);
  if (frame === null || (frame[1] !== undefined && frame[2] !== undefined)) return false;
  return isPoliteTail(core.slice(frame[0].length), asked) && !NEGATION.test(around);
}

/** Whether a typed request starts a timer: a verb for it or the bare form, and no word that makes it something else. */
function asksForTimer(text) {
  if (!TIMER_WORD.test(text) || NEGATION.test(text) || NOT_A_START.test(text)) return false;
  if (START_TIMER_WORD.test(text)) return true;
  const { core, asked } = withoutLead(text);
  const tail = /(?:,? please)?[.!?]?$/u.exec(core)[0];
  return isPoliteTail(tail, asked) && BARE_TIMER.test(core.slice(0, core.length - tail.length));
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
 *   post_to_chat             the typed text is the message, once, in a small
 *                            frame and nothing else (isPlainPost): a verb
 *                            (post, write, send, say, put), "this"/"that",
 *                            the chat named before or after the message,
 *                            quotes around it, the polite words. "don't post
 *                            hello team" and "what does hello mean": the sheet
 *   share_notes              the typed text is "share the notes", "share
 *                            notes", "share arlo's notes" or "share my
 *                            notes", with "with everyone / everybody / the
 *                            meeting / all" after it or not, and nothing else
 *                            but the polite words
 *   send_reaction            the typed text has a word of that reaction as a
 *                            word of its own (REACTION_WORDS: "thumbs up" for
 *                            thumbs_up, not "thumbnail"; "love" for heart, not
 *                            "glove") or that reaction's emoji, and no
 *                            NEGATION word
 *   mute_participant         the typed text is "mute <name>" and nothing else:
 *                            the name as a whole, as the tool call has it,
 *                            with "Hey Arlo," / "can you" / "could you" /
 *                            "would you" / "please" before it and "please",
 *                            "." or "!" after it at most ("?" only after "can
 *                            you" and the like). So "unmute Danny", "don't
 *                            mute Danny", "mute everyone except Danny" and
 *                            "mute Danny and Sam" that a model turned into
 *                            muting Danny go to the sheet
 *   admit_from_waiting_room  the same, for "admit <name>" or "let <name> in",
 *                            each with or without "from the waiting room"
 *   open_issue               the typed text names exactly one issue, it is
 *                            the tool call's number, and the text has no
 *                            other digit (onlyIssueIn, lib/github.js: "issue
 *                            42", "issue #42", "issue number 42", "issue no.
 *                            42", "#42"; not "open 42", "ticket 42", "issue
 *                            forty two", "issue 42 and 43"); before it the
 *                            text has "open", "pull up", "bring up" or "show"
 *                            as a word, and nowhere a NEGATION word; and when the
 *                            share dialog would be opened too, "share" or
 *                            "sharing" as a word ("screen share" too; not
 *                            "shared")
 *   set_timer                the typed text has the word "timer"; a verb that
 *                            starts one (set, start, put, give) or is the
 *                            bare form ("5 minute timer", "timer for 5
 *                            minutes"); no NEGATION word and none of
 *                            NOT_A_START ("cancel the 5 minute timer", "add 5
 *                            minutes to the timer"); and a length of time
 *                            that is exactly the tool call's minutes: digits
 *                            or a number word of MINUTE_WORDS with
 *                            "minute(s)", "min(s)" or "hour(s)", "an hour"
 *                            (60) or "half an hour" (30). Two different
 *                            lengths, seconds or a number that is not read
 *                            for sure ("twenty five minutes"): the sheet
 *   stop_timer               the typed text is "stop / cancel / end (the)
 *                            timer" and nothing else but the polite words
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
  if (toolName === 'post_to_chat') return isPlainPost(typed, args.message);
  if (toolName === 'share_notes') return isPlainRequest(text, SHARE_NOTES_FORMS);
  if (toolName === 'send_reaction') {
    const { reaction } = args;
    return typeof reaction === 'string' && Object.prototype.hasOwnProperty.call(REACTION_WORDS, reaction)
      && (REACTION_WORDS[reaction].test(text) || text.includes(REACTION_EMOJI[reaction])) && !NEGATION.test(text);
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
  if (toolName === 'open_issue') {
    const { number, share } = args;
    if (!isIssueNumber(number) || typeof share !== 'boolean') return false;
    // Read from the text as it was typed: a digit of another script, or one
    // behind an invisible character, is not made a plain digit first
    const named = onlyIssueIn(typed);
    if (named === null || named.number !== number) return false;
    // The words that name the issue are not part of the request around it
    // and the word that opens stands before them ("is issue 42 open?" asks nothing)
    const around = plain(named.around);
    if (!OPEN_WORD.test(plain(named.before)) || NEGATION.test(around)) return false;
    return share === false || SHARE_WORD.test(around);
  }
  if (toolName === 'set_timer') {
    const { minutes } = args;
    if (!isTimerMinutes(minutes) || !asksForTimer(text)) return false;
    const said = minutesIn(text);
    return said.length > 0 && said.every((one) => one === minutes);
  }
  if (toolName === 'stop_timer') return isPlainRequest(text, STOP_TIMER_FORMS);
  return false;
}

module.exports = {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers, minutesIn,
};
