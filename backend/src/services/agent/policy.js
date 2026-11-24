/**
 * What happens to a request to Arlo: a pure function of four facts the server
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
 *
 * Outcomes:
 *   'run'     do it now
 *   'sheet'   ask the owners first (the approval sheet on their panels)
 *   'refuse'  a typed request that is not done; the asker is told
 *   'silent'  a spoken request that is not done; nothing is said or shown
 *
 *   panel, owner                 read, change: run          none: refuse
 *   panel, other, anyone can ask read: run   change: sheet  none: refuse
 *   panel, other, only owners    refuse
 *   voice, owner (verified)      read, change: run          none: silent
 *   voice, other, anyone can ask read: run   change: sheet  none: silent
 *   voice, other, only owners    read, change: sheet        none: silent
 *
 * Anything unknown takes the stricter way: never 'run'.
 */
const ASKERS = new Set(['owner', 'other']);
const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const DOES_SOMETHING = new Set(['read', 'change']);

/** Whether this person may type a request to Arlo in this meeting at all. */
function panelMayAsk({ asker, whoCanAsk } = {}) {
  if (asker === 'owner') return true;
  return asker === 'other' && whoCanAsk === 'anyone';
}

function decide(input) {
  const {
    channel, asker, whoCanAsk, toolKind,
  } = input !== null && typeof input === 'object' ? input : {};

  if (channel === 'voice') {
    if (!ASKERS.has(asker) || !DOES_SOMETHING.has(toolKind)) return 'silent';
    if (asker === 'owner') return 'run';
    // A setting that is not known is the stricter one
    if (whoCanAsk !== 'anyone') return 'sheet';
    return toolKind === 'read' ? 'run' : 'sheet';
  }

  if (channel === 'panel') {
    if (!ASKERS.has(asker) || !WHO_CAN_ASK.has(whoCanAsk) || !DOES_SOMETHING.has(toolKind)) return 'refuse';
    if (!panelMayAsk({ asker, whoCanAsk })) return 'refuse';
    if (asker === 'owner') return 'run';
    return toolKind === 'read' ? 'run' : 'sheet';
  }

  return 'refuse';
}

module.exports = { decide, panelMayAsk };
