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

/** Compared without case and with every run of whitespace as one space. */
const folded = (value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * Defence in depth for an owner's typed request: whether what a tool that
 * changes the meeting would do is in what the owner typed. A model picked the
 * tool and wrote its arguments; when they are not the owner's own words, the
 * owner gets the sheet like anyone else.
 *   post_to_chat             the message appears in the typed text
 *   admit_from_waiting_room  the name appears in the typed text
 *   share_notes              the typed text has the word "share"
 * Any other tool, or anything that is not text: false.
 */
function typedRequestCovers(typed, toolName, args) {
  if (typeof typed !== 'string' || args === null || typeof args !== 'object') return false;
  const said = (value) => typeof value === 'string' && folded(value).length > 0 && folded(typed).includes(folded(value));
  if (toolName === 'post_to_chat') return said(args.message);
  if (toolName === 'admit_from_waiting_room') return said(args.name);
  if (toolName === 'share_notes') return /(?<![\p{L}\p{N}_])share(?![\p{L}\p{N}_])/iu.test(typed);
  return false;
}

module.exports = {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers,
};
