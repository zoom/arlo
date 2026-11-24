/**
 * The name of the person who brought Arlo in, and the sentences that use it.
 *
 * The server can have no name for them (sign-in without the Zoom scope that
 * gives names). A missing or blank name is "no name" everywhere, decided here
 * once, so no sentence is ever shown with a gap where the name should be.
 */
const MAX_NAME_CHARS = 200;

// The server's rule (backend/src/lib/displayName.js), applied to a name from
// any source: no control, format (zero-width, soft hyphen, direction override),
// private-use or unassigned characters, no line or paragraph separators, no
// Hangul fillers (letters by category, shown as a blank), and at least one
// letter or digit. A name that fails reads as no name: it would show as a gap,
// or turn the sentence around it.
// The zero-width non-joiner and joiner are allowed: Persian and Indic names and emoji sequences use them
const NOT_IN_A_NAME = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u3164\u115F\u1160\uFFA0]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const isShowable = (name) => LETTER_OR_DIGIT.test(name) && !NOT_IN_A_NAME.test(name);

/**
 * The name NFC-normalized, trimmed and bounded, or null when there is none:
 * not a string, blank, or not showable (see above).
 */
export function usableName(value, max = MAX_NAME_CHARS) {
  if (typeof value !== 'string') return null;
  const whole = value.normalize('NFC').trim();
  if (!isShowable(whole)) return null;
  // The cut must not leave half an emoji (a lone surrogate) at the end
  const name = whole.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trim();
  return isShowable(name) ? name : null;
}

/** The heading over notes an owner shares with everyone in the meeting. */
export function sharedNotesHeading(ownerName) {
  const name = usableName(ownerName);
  return name === null ? 'Arlo\'s notes are shared with everyone' : `${name} is sharing Arlo's notes`;
}

/** What a participant reads about whose Arlo this is: { heading, body }. */
export function ownerWording(ownerName) {
  const name = usableName(ownerName);
  if (name === null) {
    return {
      heading: 'Arlo is in this meeting',
      body: 'Arlo reads Zoom\'s live transcript to take notes for the person who brought it in. Nothing is stored after the meeting ends.',
    };
  }
  return {
    heading: `${name} brought Arlo into this meeting`,
    body: `Arlo reads Zoom's live transcript to take notes for ${name}. Nothing is stored after the meeting ends.`,
  };
}
