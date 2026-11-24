/**
 * What the server says Arlo is doing right now (`step` and `channel` of
 * `arlo.thinking`), read as untrusted input. The step is a sentence the
 * server wrote; one part of it (the name of someone to admit) came from a
 * request, so it is cleaned here again and only ever rendered as text.
 */
export const MAX_STEP_CHARS = 120;

// Never shown: control characters, invisible format characters (a direction
// override turns the text around it), private-use and unassigned characters,
// lone surrogates, line and paragraph separators. The two joiners that names
// and emoji sequences need stay.
const NOT_SHOWN = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
const CHANNELS = new Set(['voice', 'panel']);

/** The step as it can be shown, or null: a string of 1 to 120 characters once cleaned and trimmed. */
export function readThinkingStep(value) {
  if (typeof value !== 'string' || value.length > MAX_STEP_CHARS * 4) return null;
  const step = value.replace(NOT_SHOWN, '').trim();
  return step.length > 0 && step.length <= MAX_STEP_CHARS ? step : null;
}

/** 'voice' (said in the meeting) or 'panel' (typed), or null. */
export function readThinkingChannel(value) {
  return typeof value === 'string' && CHANNELS.has(value) ? value : null;
}
