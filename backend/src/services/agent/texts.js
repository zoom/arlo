/**
 * Every sentence Arlo's agent writes: what the record says it was asked and
 * did, what the approval sheet asks an owner, and what a panel is answered.
 * And the one place text bound for the meeting chat, or for the approval
 * sheet, is cleaned (chatText, cleanLine).
 *
 * The sentences are templates of this server. The only things filled in are a
 * tool call's arguments after validateToolCall() accepted them
 * (services/agent/tools.js). A model's own words are never a label, a
 * question or a button: text a model wrote that is to be posted is the
 * sheet's `body`, shown as what it is.
 *
 * What a panel is told Arlo is doing right now (STEPS, toolStep) is from this
 * file too, picked by where the run is; the one thing filled in is the name
 * of someone to admit, cleaned and cut here.
 *
 * Arlo posts no line of its own to the chat: not "I am busy", not "the host
 * declined". A line nobody approved is unapproved content; those outcomes are
 * in the record only.
 */

const { cleanName } = require('../../lib/displayName');

// Never part of text that is shown or posted: control characters, invisible
// format characters (a direction override turns the text around it),
// private-use and unassigned characters, lone surrogates, line and paragraph
// separators. The joiners that names and emoji sequences need are allowed, as
// in lib/displayName.js. The tool table refuses an argument that has one
// (services/agent/tools.js); text a model wrote loses them here.
const NOT_IN_TEXT = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
const NOT_IN_TEXT_ANYWHERE = new RegExp(NOT_IN_TEXT.source, 'gu');
// "Arlo:" at the start, any case, with or without spaces, a full-width colon too
const OWN_PREFIX = /^(?:arlo\s*[:：]\s*)+/iu;

const MAX_CHAT_ANSWER_CHARS = 500;
const MAX_CHAT_MESSAGE_CHARS = 300;
const MAX_SHEET_REQUEST_CHARS = 200;
const MAX_SHEET_NAME_CHARS = 60;

/** NFC, every line break and run of whitespace one space, no character of NOT_IN_TEXT, trimmed. */
function plainLine(value) {
  return value.normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(NOT_IN_TEXT_ANYWHERE, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** At most `max` characters: cut at a word where there is one, with an ellipsis, never ending in half an emoji. */
function cutAtWord(value, max) {
  if (value.length <= max) return value;
  let kept = value.slice(0, max - 1);
  const space = kept.lastIndexOf(' ');
  // A word that fills more than half of what is allowed is cut inside
  if (value[max - 1] !== ' ' && space >= max / 2) kept = kept.slice(0, space);
  return `${kept.replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
}

/**
 * One line of plain text of at most `max` characters, or null when nothing is
 * left: what someone asked, or a name, as the approval sheet shows it and as
 * the model that picks a tool gets it.
 */
function cleanLine(value, max) {
  if (typeof value !== 'string') return null;
  const line = cutAtWord(plainLine(value), max);
  return line.length > 0 ? line : null;
}

/**
 * Text as it may be posted to the meeting chat, or null when nothing is left:
 * one line of plain text (cleanLine), without an "Arlo:" of its own at the
 * start (the posted line gets the one prefix, so a second speaker line cannot
 * be faked), at most `max` characters. Cleaning a cleaned text changes nothing.
 */
function chatText(value, max) {
  if (typeof value !== 'string') return null;
  const text = cutAtWord(plainLine(value).replace(OWN_PREFIX, '').trim(), max);
  return text.length > 0 ? text : null;
}

/**
 * Per tool:
 *   asked(args)     the record while it waits, and when it was declined, ran out or failed
 *   done(args)      the record when it was done
 *   question(args)  the approval sheet's question. Text that will be posted is never in
 *                   it: that is the sheet's `body` (services/agent/agent.js)
 *   primary(args)   the sheet's button that agrees
 *   reply(args)     what the panel of someone who typed the request is answered when it is done
 */
// The sheet for text a model wrote (an answer, a summary): the text is the body
const POST_ANSWER_QUESTION = 'Post Arlo\'s answer in the meeting chat?';
const POST_ANSWER_PRIMARY = 'Post answer';

const TOOL_TEXTS = Object.freeze({
  answer_from_meeting: Object.freeze({
    asked: () => 'Asked a question',
    done: () => 'Answered a question',
    question: () => POST_ANSWER_QUESTION,
    primary: () => POST_ANSWER_PRIMARY,
    reply: () => 'Done: answered.',
  }),
  summarize_so_far: Object.freeze({
    asked: () => 'Asked for a summary',
    done: () => 'Summarized the meeting so far',
    question: () => POST_ANSWER_QUESTION,
    primary: () => POST_ANSWER_PRIMARY,
    reply: () => 'Done: summarized the meeting so far.',
  }),
  post_to_chat: Object.freeze({
    asked: () => 'Asked to post to chat',
    done: () => 'Posted to chat',
    // The message is the sheet's body: what the owner approves is what is posted
    question: () => 'Post this in the meeting chat?',
    primary: () => 'Post to chat',
    reply: () => 'Done: posted to chat.',
  }),
  admit_from_waiting_room: Object.freeze({
    asked: (args) => `Asked to admit ${args.name} from the waiting room`,
    done: (args) => `Admitted ${args.name} from the waiting room`,
    question: (args) => `Admit ${args.name} from the waiting room?`,
    primary: (args) => `Admit ${args.name}`,
    reply: (args) => `Done: admitted ${args.name} from the waiting room.`,
  }),
  share_notes: Object.freeze({
    asked: () => 'Asked to share the notes with everyone',
    done: () => 'Shared the notes with everyone',
    question: () => 'Share the notes with everyone in the meeting?',
    primary: () => 'Share notes',
    reply: () => 'Done: shared the notes with everyone.',
  }),
  web_search: Object.freeze({
    asked: () => 'Asked for a web search',
    done: () => 'Searched the web',
    question: () => POST_ANSWER_QUESTION,
    primary: () => POST_ANSWER_PRIMARY,
    reply: () => 'Done: searched the web.',
  }),
});

/** A request the model that picks a tool could not be asked about. Owners only. */
const NOT_UNDERSTOOD_LABEL = 'Could not understand a request';

// Why something was not done, by outcome code
const REASONS = Object.freeze({
  no_hands: 'nobody who can do it has Arlo open in the meeting',
  timeout: 'it took too long',
  not_found: 'nobody by that name is in the waiting room',
  several_match: 'several people in the waiting room match that name',
  no_notes: 'there are no notes yet',
  sdk_error: 'Zoom did not do it',
  unsupported: 'this version of Zoom or Arlo cannot do that',
  not_allowed: 'that is not allowed here',
  no_transcript: 'nothing has been said since Arlo joined',
  model_rate_limited: 'the AI models are rate limited right now',
  model_error: 'the AI service could not answer right now',
  busy: 'too many requests are waiting for an answer',
  empty: 'there was nothing to post',
});

/** What a panel is answered when a request it typed was not done. */
const couldNot = (code) => `I couldn't do that: ${Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : 'something went wrong'}.`;

/**
 * No panel of the owner who typed or approved it can do it: what the record
 * and the asker's panel say. An action runs only on that owner's own panel.
 */
const NO_HANDS = Object.freeze({
  host: 'Arlo needs the host\'s panel for that.',
  chat: 'Open Arlo to let it post in the chat.',
});
const noHands = (toolName) => (toolName === 'admit_from_waiting_room' ? NO_HANDS.host : NO_HANDS.chat);
/** The record of a request that was dropped because the owners have as many sheets open as they take. */
const TOO_MANY_WAITING_LABEL = 'Too many requests are waiting';

const REPLIES = Object.freeze({
  none: 'I didn\'t catch a request.',
  waitingApproval: 'I asked the person who brought Arlo in to approve that.',
});

/**
 * What an owner's panel is told Arlo is doing right now (`step` of
 * `arlo.thinking`). A fixed table: where the run is picks the sentence, never
 * a model, and no request, answer or transcript text is in one.
 */
const MAX_STEP_CHARS = 120;
const MAX_STEP_NAME_CHARS = 60;
const STEPS = Object.freeze({
  // A spoken request was detected; no model has been asked yet
  heard: 'Heard a request',
  // A model picks a tool
  choosing: 'Working out what was asked',
  answering: 'Writing an answer',
  summarizing: 'Writing a summary',
  posting: 'Posting to the meeting chat',
  sharing: 'Sharing the notes with everyone',
  admittingSomeone: 'Admitting someone from the waiting room',
});
const TOOL_STEPS = Object.freeze({
  answer_from_meeting: () => STEPS.answering,
  summarize_so_far: () => STEPS.summarizing,
  post_to_chat: () => STEPS.posting,
  share_notes: () => STEPS.sharing,
  admit_from_waiting_room: (args) => {
    // The name came with the request: shown only when it is a name (lib/displayName.js), and short
    const name = cleanName(args !== null && typeof args === 'object' ? args.name : null, MAX_STEP_NAME_CHARS);
    return name.length > 0 ? `Admitting ${name} from the waiting room` : STEPS.admittingSomeone;
  },
});

/** The step while this tool runs, or null for a tool that has none (then the step before it stays). */
function toolStep(toolName, args) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_STEPS, toolName)) return null;
  const step = TOOL_STEPS[toolName](args);
  return step.length <= MAX_STEP_CHARS ? step : null;
}

// What is posted to the meeting chat is this, then the text an owner approved or typed
const CHAT_PREFIX = 'Arlo: ';

module.exports = {
  TOOL_TEXTS,
  NOT_UNDERSTOOD_LABEL,
  REPLIES,
  CHAT_PREFIX,
  couldNot,
  noHands,
  TOO_MANY_WAITING_LABEL,
  cleanLine,
  chatText,
  NOT_IN_TEXT,
  MAX_CHAT_ANSWER_CHARS,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_SHEET_REQUEST_CHARS,
  MAX_SHEET_NAME_CHARS,
  STEPS,
  toolStep,
  MAX_STEP_CHARS,
};
