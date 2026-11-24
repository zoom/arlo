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
 *   'run'     do it now
 *   'sheet'   ask the owners first (the approval sheet on their panels)
 *   'answer'  a typed request no tool fits: answered from the meeting's
 *             transcript with the text as typed, as the Ask input always did
 *   'refuse'  a typed request that is not done; the asker is told
 *   'silent'  a spoken request that is not done; nothing is said or shown
 *
 *   panel, owner                 read, change: run          none: answer
 *   panel, other, anyone can ask read: run   change: sheet  none: answer
 *   panel, other, only owners    refuse
 *   voice, no owner's panel open silent (whoever spoke, whatever was asked)
 *   voice, owner (verified)      read, change: run          none: silent
 *   voice, other, anyone can ask read: run   change: sheet  none: silent
 *   voice, other, only owners    read, change: sheet        none: silent
 *
 * A spoken request needs an owner's open panel for everything it could lead
 * to: the answer is posted through it, the sheet is shown on it. Without one
 * it is dropped before any model is asked (voiceIsHeard), so no transcript
 * goes to the AI provider for something nobody could see.
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
    if (asker === 'owner') return 'run';
    // A setting that is not known is the stricter one
    if (whoCanAsk !== 'anyone') return 'sheet';
    return toolKind === 'read' ? 'run' : 'sheet';
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

module.exports = { decide, panelMayAsk, voiceIsHeard };
