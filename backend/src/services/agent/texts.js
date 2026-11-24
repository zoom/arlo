/**
 * Every sentence Arlo's agent writes: what the record says it was asked and
 * did, what the approval sheet asks an owner, what a panel is answered, and
 * the few lines it posts to the meeting chat.
 *
 * All of them are templates of this server. The only things filled in are a
 * tool call's arguments after validateToolCall() accepted them
 * (services/agent/tools.js), shortened where the place is small. A model's own
 * words are never a label, a question or a button.
 */
const SHEET_QUESTION_QUOTE_CHARS = 140;

/** One line, cut to `max` characters with an ellipsis, never ending in half an emoji. */
function short(value, max) {
  const oneLine = String(value).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * Per tool:
 *   asked(args)     the record while it waits, and when it was declined, ran out or failed
 *   done(args)      the record when it was done
 *   question(args)  the approval sheet's question
 *   primary(args)   the sheet's button that agrees
 *   reply(args)     what the panel of someone who typed the request is answered when it is done
 */
const TOOL_TEXTS = Object.freeze({
  answer_from_meeting: Object.freeze({
    asked: () => 'Asked a question',
    done: () => 'Answered a question',
    question: (args) => `Answer “${short(args.question, SHEET_QUESTION_QUOTE_CHARS)}” in the meeting chat?`,
    primary: () => 'Answer',
    reply: () => 'Done: answered.',
  }),
  summarize_so_far: Object.freeze({
    asked: () => 'Asked for a summary',
    done: () => 'Summarized the meeting so far',
    question: () => 'Post a summary of the meeting so far to the meeting chat?',
    primary: () => 'Post summary',
    reply: () => 'Done: summarized the meeting so far.',
  }),
  post_to_chat: Object.freeze({
    asked: () => 'Asked to post to chat',
    done: () => 'Posted to chat',
    // The whole message, line breaks and all (at most 300 characters,
    // services/agent/tools.js): what the owner approves is what is posted
    question: (args) => `Post “${args.message}” to the meeting chat?`,
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
    question: () => 'Search the web and post the answer to the meeting chat?',
    primary: () => 'Search',
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
});

/** What a panel is answered when a request it typed was not done. */
const couldNot = (code) => `I couldn't do that: ${Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : 'something went wrong'}.`;

const REPLIES = Object.freeze({
  none: 'I didn\'t catch a request.',
  waitingApproval: 'I asked the person who brought Arlo in to approve that.',
});

// Lines Arlo posts to the meeting chat itself
const CHAT_PREFIX = 'Arlo: ';
const CHAT = Object.freeze({
  busy: `${CHAT_PREFIX}I am busy right now. Ask again in a moment.`,
  declined: `${CHAT_PREFIX}The host declined that request.`,
  expired: `${CHAT_PREFIX}The host did not answer that request.`,
});

module.exports = {
  TOOL_TEXTS, NOT_UNDERSTOOD_LABEL, REPLIES, CHAT, CHAT_PREFIX, couldNot, short,
};
