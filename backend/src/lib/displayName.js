/**
 * A person's display name as the server keeps it: trimmed and bounded, and an
 * empty string when there is none. Never a blank: a name made of spaces would
 * be shown to a whole meeting as a gap in a sentence.
 *
 * Names are personal data: nothing here logs one.
 */
const MAX_NAME_CHARS = 200;

/** A string cut to `max` characters, as a fresh copy that does not end in half an emoji. */
const bounded = (value, max) => (value.length > max ? Buffer.from(value.slice(0, max), 'utf8').toString('utf8').replace(/�+$/u, '') : value);

/** The name in `value`, trimmed and at most `max` characters; '' when it is not a name. */
function cleanName(value, max = MAX_NAME_CHARS) {
  if (typeof value !== 'string') return '';
  return bounded(value.trim(), max).trim();
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

module.exports = { cleanName, displayNameFrom, MAX_NAME_CHARS };
