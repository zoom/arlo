/**
 * GitHub issues: the deployment's repository, an issue number, and the one
 * URL that is ever built from the two.
 *
 * A model or a speaker never supplies a URL or a repository. They name an
 * issue by its number ("issue 42"); the number is rebuilt here and refused
 * unless it is a whole number from 1 to 9999999. The URL is
 * "https://github.com/", the configured repository, "/issues/", that number:
 * nothing else is ever sent to a panel to open.
 *
 * Nothing here calls GitHub, and there is no token. Nothing here is logged: a
 * number is what someone asked for.
 */

const GITHUB = 'https://github.com/';
const MAX_ISSUE_NUMBER = 9999999;
const MAX_TYPED_CHARS = 2000;

/**
 * "owner/name": an owner of 1 to 39 letters, digits and dashes that neither
 * starts nor ends with a dash, and a name of 1 to 100 letters, digits, "_",
 * "." and "-".
 */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
// A number as plain digits: no sign, no space, no leading zero, at most seven
const DIGITS = /^[1-9][0-9]{0,6}$/;

// An issue named in a text someone typed: "issue 42", "issue #42", "issue
// number 42", "issue no. 42", or "#42" by itself (the # not after a letter or
// digit). The number as plain digits, and nothing after it that would make it
// another number or a word: a digit, a letter, "_", "-", or "." and a digit
const REFERENCE = /(?:(?<![\p{L}\p{N}_-])issue (?:number |no\. ?|#)?|(?<![\p{L}\p{N}])#)([1-9][0-9]{0,6})(?![\p{L}\p{N}_-]|\.[0-9])/gu;

// Only A to Z are made lower case: with the "i" flag other letters would
// match these too ("ſ" as "s"), and a look-alike is not the letter
const lowerAscii = (value) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * GITHUB_DEFAULT_REPO as it is used, or null: { repo, known }. `known` is
 * false for a value that is set and not accepted (the caller warns once,
 * without the value). Accepted: "owner/name" as REPO has it, where the name
 * is not "." or "..". Never trimmed or repaired.
 */
function readGithubRepo(raw) {
  if (raw === undefined || raw === null || raw === '') return { repo: null, known: true };
  const refused = { repo: null, known: false };
  if (typeof raw !== 'string' || !REPO.test(raw)) return refused;
  const name = raw.slice(raw.indexOf('/') + 1);
  if (name === '.' || name === '..') return refused;
  return { repo: raw, known: true };
}

/** Whether this is an issue number as normalizeIssueNumber() returns one. */
const isIssueNumber = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;

/**
 * The issue number in what a model gave as one, or null: a whole number from
 * 1 to 9999999, or the same written as plain digits ("42"), rebuilt as the
 * number. Anything else is refused, never repaired: a sign, a space, a
 * leading zero, "42.5", "1e3", "42abc", digits of another script, a URL.
 */
function normalizeIssueNumber(value) {
  if (typeof value === 'string') return DIGITS.test(value) ? Number(value) : null;
  return isIssueNumber(value) ? value : null;
}

/** Where a text someone typed names an issue: [{ number, start, end }] in the text with single spaces. */
function referencesIn(text) {
  return [...text.matchAll(REFERENCE)].map((found) => ({
    number: Number(found[1]), start: found.index, end: found.index + found[0].length,
  }));
}

/** A typed text as it is read: single spaces, A to Z lower case; null when it is not text or too long. */
function readable(text) {
  if (typeof text !== 'string' || text.length > MAX_TYPED_CHARS) return null;
  return lowerAscii(text.replace(/\s+/gu, ' '));
}

/**
 * The number of every issue named in a text someone typed, in the order they
 * are named, each as often as it is named: "open issue 42" and "pull up #42"
 * have 42. "open 42", "ticket 42", "in 42 minutes", "issue forty two", "issue
 * 042", "issue 42.5" and "issue 42-43" name none.
 */
function issueNumbersIn(text) {
  const read = readable(text);
  return read === null ? [] : referencesIn(read).map((one) => one.number);
}

/**
 * The one issue a typed text names, or null: exactly one is named, and the
 * text has no other digit of any script ("open issue 42 and 43" names an
 * issue and then another number, and nobody can say what that one is).
 * -> { number, before, around }: `around` is the text without the words that
 * name the issue ("issue no. 42" is not a "no"), `before` the part of it in
 * front of them.
 */
function onlyIssueIn(text) {
  const read = readable(text);
  if (read === null) return null;
  const found = referencesIn(read);
  if (found.length !== 1) return null;
  const [{ number, start, end }] = found;
  const before = read.slice(0, start);
  const around = `${before} ${read.slice(end)}`;
  if (/\p{N}/u.test(around)) return null;
  return { number, before, around };
}

/** The URL of an issue: GitHub, the repository, "/issues/", the number. null unless both are what this file accepts. */
function issueUrl(repo, number) {
  if (!isIssueNumber(number)) return null;
  if (typeof repo !== 'string' || readGithubRepo(repo).repo !== repo) return null;
  return `${GITHUB}${repo}/issues/${number}`;
}

module.exports = {
  readGithubRepo, normalizeIssueNumber, isIssueNumber, issueNumbersIn, onlyIssueIn, issueUrl, MAX_ISSUE_NUMBER,
};
