/**
 * Jira tickets: the deployment's base URL, a ticket key, and the one URL that
 * is ever built from the two.
 *
 * A model or a speaker never supplies a URL. They name a ticket ("PROJ-123",
 * "proj 123", "PROJ dash 123"); the key is rebuilt here and refused unless it
 * is letters, one dash and a number. The URL is the configured base, then
 * "/browse/", then that key: nothing else is ever sent to a panel to open.
 *
 * Nothing here is logged: a key is what someone asked for.
 */

const MAX_BASE_URL_CHARS = 200;
// What a model may give as a key ("PROJ hyphen 123" fits), before it is rebuilt
const MAX_RAW_KEY_CHARS = 40;
const MAX_TYPED_CHARS = 2000;

/** A ticket key: a project of 2 to 10 letters and digits that starts with a letter, a dash, a number of 1 to 7 digits. */
const TICKET_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

// Between the project and the number: a dash (spaces around it or not), the
// word "dash" or "hyphen" with spaces around it, or a run of spaces and underscores
const BETWEEN = '(?: *- *| +(?:DASH|HYPHEN) +|[ _]+)';
const WHOLE_KEY = new RegExp(`^([A-Z][A-Z0-9]{1,9})${BETWEEN}(\\d{1,7})$`);
// The same in a text someone typed, as it was typed: what stands between the
// project and the number is kept, to tell "PROJ 123" from "version 2"
const KEY_IN_TEXT = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})( *- *| +(?:dash|hyphen) +|[ _]+)(\d{1,7})(?![A-Za-z0-9])/gi;

// Only a to z are made upper case: String.toUpperCase turns other letters
// into these too ("ı" into "I", "ſ" into "S"), and a look-alike is not the letter
const upperAscii = (value) => value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

/**
 * JIRA_BASE_URL as it is used, or null: { url, known }. `known` is false for
 * a value that is set and not accepted (the caller warns once, without the
 * value). Accepted: https, a host, an optional path (a context path), nothing
 * else: no user name or password, no query, no fragment, at most 200
 * characters. A trailing slash is dropped.
 */
function readJiraBaseUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return { url: null, known: true };
  const refused = { url: null, known: false };
  if (typeof raw !== 'string' || raw.length > MAX_BASE_URL_CHARS) return refused;
  // Printable ASCII without spaces, and nothing a URL parser would quietly repair
  if (!/^[\x21-\x7E]+$/.test(raw) || /[\\?#@]/.test(raw) || !/^https:\/\/[^/]/i.test(raw)) return refused;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return refused;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) return refused;
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return refused;
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  if (!url.startsWith('https://') || url.length > MAX_BASE_URL_CHARS) return refused;
  return { url, known: true };
}

/**
 * The ticket key in what a model gave as one, or null. Trimmed, upper case,
 * and what stands between the project and the number is one dash: "proj 123",
 * "PROJ_123", "PROJ dash 123" and "proj-123" are all PROJ-123. Anything else
 * is refused, never repaired: a URL, a path, a letter that only looks like
 * one of A to Z, a control character.
 */
function normalizeTicketKey(value) {
  if (typeof value !== 'string' || value.length > MAX_RAW_KEY_CHARS) return null;
  // Printable ASCII only, before anything is trimmed or changed
  if (!/^[\x20-\x7E]+$/.test(value)) return null;
  const found = WHOLE_KEY.exec(upperAscii(value.trim()));
  if (found === null) return null;
  const key = `${found[1]}-${found[2]}`;
  return TICKET_KEY.test(key) ? key : null;
}

/** Whether this is a ticket key as normalizeTicketKey() returns one. */
const isTicketKey = (value) => typeof value === 'string' && TICKET_KEY.test(value);

/**
 * Every ticket key written in a text someone typed: "open PROJ-123", "open
 * proj-123", "open proj_123" and "open proj dash 123" all have PROJ-123. With
 * only a space between the two it is a key when the project is typed in upper
 * case ("open PROJ 123"): "ticket 42", "in 5" and "version 2" are ordinary
 * words and a number.
 */
function ticketKeysIn(text) {
  if (typeof text !== 'string' || text.length > MAX_TYPED_CHARS) return [];
  const keys = new Set();
  for (const found of text.replace(/\s+/gu, ' ').matchAll(KEY_IN_TEXT)) {
    const [, project, between, number] = found;
    if (/^ +$/.test(between) && /[a-z]/.test(project)) continue;
    keys.add(`${upperAscii(project)}-${number}`);
  }
  return [...keys];
}

/** The URL of a ticket: the base, "/browse/", the key. null unless both are what this file accepts. */
function ticketUrl(baseUrl, key) {
  if (!isTicketKey(key)) return null;
  const base = readJiraBaseUrl(baseUrl).url;
  // Only a base that is already in the form it is used in
  if (base === null || base !== baseUrl) return null;
  return `${base}/browse/${key}`;
}

module.exports = {
  readJiraBaseUrl, normalizeTicketKey, isTicketKey, ticketKeysIn, ticketUrl, TICKET_KEY,
};
