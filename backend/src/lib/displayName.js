/**
 * A person's display name as the server keeps it: trimmed and bounded, and an
 * empty string when there is none. Never a blank: a name made of spaces, or of
 * characters that show as nothing, would be shown to a whole meeting as a gap
 * in a sentence.
 *
 * Names are personal data: nothing here logs one.
 */
const MAX_NAME_CHARS = 200;

// What is never part of a name shown to a meeting:
//   Cc  control characters (C0, DEL, C1)
//   Cf  format characters: zero-width space and joiners, soft hyphen, the
//       direction overrides (U+202E turns the sentence around the name), BOM
//   Co, Cn, Cs  private-use and unassigned characters, lone surrogates
//   Zl, Zp  line and paragraph separators
//   the Hangul fillers, which are letters by category and show as a blank
// A name with one of them is refused, not cleaned up. Two format characters
// are allowed, because real names need them: the zero-width non-joiner and
// joiner (U+200C, U+200D) that Persian and Indic scripts and emoji sequences
// use. They cannot make a name blank: a letter or digit is required as well.
const NOT_IN_A_NAME = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u3164\u115F\u1160\uFFA0]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The name in `value` as it can be shown: NFC-normalized and trimmed. '' when
 * it is not a string, holds a character that is never part of a name (above),
 * or has no letter or digit in it.
 */
function showableName(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFC').trim();
  return LETTER_OR_DIGIT.test(name) && !NOT_IN_A_NAME.test(name) ? name : '';
}

/** A string cut to `max` characters, as a fresh copy that does not end in half an emoji. */
const bounded = (value, max) => (value.length > max ? Buffer.from(value.slice(0, max), 'utf8').toString('utf8').replace(/�+$/u, '') : value);

/** The name in `value`, showable and at most `max` characters; '' when it is not a name. */
function cleanName(value, max = MAX_NAME_CHARS) {
  // Checked again after the cut: what is left must still be a name
  return showableName(bounded(showableName(value), max));
}

/**
 * The display name for a Zoom user record (GET /users/me, or the fields taken
 * from an access token's payload, which has no names). First and last name
 * when Zoom gives either, Zoom's own display name otherwise, '' when it gives none.
 */
function displayNameFrom(zoomUser) {
  if (zoomUser === null || typeof zoomUser !== 'object') return '';
  const parts = [cleanName(zoomUser.first_name), cleanName(zoomUser.last_name)].filter((part) => part.length > 0);
  return parts.length > 0 ? cleanName(parts.join(' ')) : cleanName(zoomUser.display_name);
}

module.exports = { cleanName, showableName, displayNameFrom, MAX_NAME_CHARS };
