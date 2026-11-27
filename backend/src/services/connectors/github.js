/**
 * The GitHub connector: three tools of Arlo's own, each one call to GitHub's
 * REST API, all in the deployment's one repository, each as one user.
 *
 *   github_list_issues   { query?, label? }  -> GET  /repos/{owner}/{repo}/issues           (read)
 *   github_get_issue     { number }          -> GET  /repos/{owner}/{repo}/issues/{number}  (read)
 *   github_create_issue  { title, body? }    -> POST /repos/{owner}/{repo}/issues           (write)
 *
 * The rules:
 * - Whose GitHub: `call(tool, args, { userId })` takes that user's own token
 *   from the connection store (services/connectors/githubConnections.js) for
 *   this one call. There is no deployment token. Not connected: 'not_connected',
 *   and nothing is sent. One user's token is never used for another's call.
 * - The repository is always `defaultRepo`. No argument names another one,
 *   so a model or a speaker cannot reach one. GitHub decides what the
 *   connected person may do there.
 * - Arlo builds everything that is sent: the path from the repository and a
 *   rebuilt number, a fixed query, and for a new issue the title and body and
 *   nothing else (no labels, assignees, milestone).
 * - 401 (GitHub refuses the token: revoked, or run out early): for a read the
 *   token is refreshed once and the call sent once more; still 401, the
 *   connection is removed and the answer is 'not_connected'. A create is never
 *   sent a second time, whatever happened to the first: its 401 is
 *   'unauthorized' (the token is refreshed for the next request).
 * - What GitHub answers is untrusted text (an issue title can read "ignore
 *   your instructions"). A result is rebuilt from the known fields: numbers
 *   checked, strings stripped of control and invisible characters and cut,
 *   lists cut. Nothing is interpreted, and no result has a URL: the panel
 *   builds a link from the repository and the number. An item whose own link
 *   is not under https://github.com/<repo>/issues/ is dropped.
 * - The list endpoint also returns pull requests ("You can identify pull
 *   requests by the pull_request key", GitHub's reference): every item with
 *   that key is dropped.
 * - A text filter: one page of the 100 most recently updated open issues is
 *   read, and their titles are compared here without regard to case. `total`
 *   is the number of matches on that page (REST gives no count).
 * - `call()` never throws: { ok: true, result } or { ok: false, code }.
 * - Nothing of an issue (title, body, label), nothing of a request, no token,
 *   login or user id is logged here. Nothing is logged here at all.
 */

const {
  readGithubRepo, normalizeIssueNumber, isIssueNumber, issueUrl,
} = require('../../lib/github');

const TOOL_NAMES = Object.freeze(['github_list_issues', 'github_get_issue', 'github_create_issue']);
const READ_TOOLS = new Set(['github_list_issues', 'github_get_issue']);

const MAX_ISSUES = 10;
const MAX_LABELS = 5;
const MAX_TITLE_CHARS = 200;
const MIN_TITLE_CHARS = 3;
const MAX_BODY_SHOWN_CHARS = 1000;
// 300 in this build: the approval sheet shows the title and the description in
// full (at most 500 characters together), and what it shows is what is sent
const MAX_BODY_SENT_CHARS = 300;
const MAX_QUERY_CHARS = 100;
const MAX_LABEL_CHARS = 50;
// The page that is read: the most recently updated open issues
const PAGE_SIZE = 100;
// A page of issues comes with their bodies (REST has no way to leave them
// out), so its answer may be longer than the 200 KB of the other calls
const MAX_LIST_BYTES = 2 * 1024 * 1024;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Control characters, invisible format characters, private use, unassigned,
// lone surrogates, line and paragraph separators
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
const UNSHOWN_BUT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
// A time as GitHub writes one: 2026-11-26T10:00:00Z
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// Text longer than this is cut before it is looked at: nothing of it could be kept
const MAX_READ_CHARS = 20000;

/** The first `max` characters, never half of a pair. */
const cut = (text, max) => (text.length <= max ? text : Array.from(text.slice(0, max * 2)).slice(0, max).join(''));

/** One line of plain text of at most `max` characters, or null when `value` is not text. */
function line(value, max) {
  if (typeof value !== 'string') return null;
  return cut(value.slice(0, MAX_READ_CHARS).replace(/[\r\n\t\p{Zl}\p{Zp}]/gu, ' ').replace(UNSHOWN, '').replace(/\s+/gu, ' ').trim(), max);
}

/** Text of several lines, of at most `max` characters, or null when `value` is not text. */
function lines(value, max) {
  if (typeof value !== 'string') return null;
  return cut(value.slice(0, MAX_READ_CHARS).replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n').replace(/\t/g, ' ').replace(UNSHOWN_BUT_NEWLINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim(), max);
}

// --- Arlo's arguments ------------------------------------------------------------------

const onlyKeys = (args, keys) => isPlainObject(args) && Object.keys(args).every((key) => keys.includes(key));
const absent = (value) => value === undefined || value === null || value === '';

/** An optional one-line text of 1 to `max` characters: { ok, value } where value is null when it is not given. */
function optionalLine(value, max) {
  if (absent(value)) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max * 4) return { ok: false };
  const read = line(value, max + 1);
  if (read.length > max) return { ok: false };
  return { ok: true, value: read === '' ? null : read };
}

/** Arlo's arguments for a tool as they are used, or null: never repaired beyond cleaning. */
function readArgs(name, args) {
  if (name === 'github_list_issues') {
    if (!onlyKeys(args, ['query', 'label'])) return null;
    const query = optionalLine(args.query, MAX_QUERY_CHARS);
    const label = optionalLine(args.label, MAX_LABEL_CHARS);
    return query.ok && label.ok ? { query: query.value, label: label.value } : null;
  }
  if (name === 'github_get_issue') {
    if (!onlyKeys(args, ['number'])) return null;
    const number = normalizeIssueNumber(args.number);
    return number === null ? null : { number };
  }
  if (name === 'github_create_issue') {
    if (!onlyKeys(args, ['title', 'body'])) return null;
    if (typeof args.title !== 'string' || args.title.length > MAX_TITLE_CHARS * 4) return null;
    const title = line(args.title, MAX_TITLE_CHARS + 1);
    if (title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) return null;
    let body = null;
    if (!absent(args.body)) {
      if (typeof args.body !== 'string' || args.body.length > MAX_BODY_SENT_CHARS * 4) return null;
      const read = lines(args.body, MAX_BODY_SENT_CHARS + 1);
      if (read.length > MAX_BODY_SENT_CHARS) return null;
      body = read === '' ? null : read;
    }
    return { title, body };
  }
  return null;
}

// --- GitHub's answers ------------------------------------------------------------------

class BadResponse extends Error {}

/** At most five label names from what an issue has as its labels. */
function labelsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const labels = [];
  for (const one of raw.slice(0, 100)) {
    const name = line(isPlainObject(one) ? one.name : one, MAX_LABEL_CHARS);
    if (name) labels.push(name);
    if (labels.length === MAX_LABELS) break;
  }
  return labels;
}

/** Whether GitHub says this item is a pull request. */
const isPullRequest = (raw) => isPlainObject(raw) && own(raw, 'pull_request') && raw.pull_request !== null && raw.pull_request !== undefined;

/**
 * The number and title of one issue of this repository, or null when what
 * GitHub gave cannot be used. GitHub's own link, when there is one, must be an
 * issue of this repository; it is checked and never kept.
 */
function issueFrom(raw, repo) {
  if (!isPlainObject(raw) || !isIssueNumber(raw.number) || isPullRequest(raw)) return null;
  const title = line(raw.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const prefix = `https://github.com/${repo}/issues/`;
  if (raw.html_url !== undefined && (typeof raw.html_url !== 'string' || !raw.html_url.startsWith(prefix))) return null;
  return { number: raw.number, title };
}

// What a status that is not 200 / 201 / 401 means. A 5xx may be a call that
// arrived: after a create it does not say that no issue was created
function failureOf(status) {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 403 || status === 429) return 'forbidden';
  if (status >= 500) return 'unreachable';
  return 'refused';
}

// --- the connector ---------------------------------------------------------------------

/**
 * @param rest         createGithubRest(): `request({ method, path, query, body, token, maxBytes })`
 * @param connections  the per-user store: `getAccessToken(userId)`,
 *                     `refreshAccessToken(userId, refusedToken)`, `drop(userId)`, `status(userId)`
 * @param defaultRepo  "owner/name", the one repository every tool works in
 */
function createGithubConnector({ rest, connections, defaultRepo } = {}) {
  if (!rest || typeof rest.request !== 'function') throw new TypeError('GitHub connector: a REST client is required');
  if (!connections || ['getAccessToken', 'refreshAccessToken', 'drop', 'status'].some((name) => typeof connections[name] !== 'function')) {
    throw new TypeError('GitHub connector: the connection store is required');
  }
  if (readGithubRepo(defaultRepo).repo !== defaultRepo || !defaultRepo) throw new TypeError('GitHub connector: the repository must be written as owner/name');
  const issuesPath = `/repos/${defaultRepo}/issues`;

  const listIssues = ({ query, label }) => ({
    send: (token) => rest.request({
      method: 'GET',
      path: issuesPath,
      query: {
        state: 'open', sort: 'updated', direction: 'desc', per_page: PAGE_SIZE, ...(label && { labels: label }),
      },
      token,
      maxBytes: MAX_LIST_BYTES,
    }),
    read: (data) => {
      if (!Array.isArray(data)) throw new BadResponse();
      let issues = [];
      const seen = new Set();
      for (const raw of data.slice(0, PAGE_SIZE)) {
        const issue = issueFrom(raw, defaultRepo);
        if (!issue || seen.has(issue.number)) continue;
        seen.add(issue.number);
        issues.push({
          ...issue,
          labels: labelsOf(raw.labels),
          updatedAt: typeof raw.updated_at === 'string' && TIMESTAMP.test(raw.updated_at) ? raw.updated_at : null,
        });
      }
      if (query) {
        // The text is never sent to GitHub: the titles of the page are compared here
        const wanted = query.toLowerCase();
        issues = issues.filter((issue) => issue.title.toLowerCase().includes(wanted));
      }
      return {
        kind: 'github_issues', repo: defaultRepo, total: issues.length, issues: issues.slice(0, MAX_ISSUES),
      };
    },
  });

  const getIssue = ({ number }) => ({
    send: (token) => rest.request({ method: 'GET', path: `${issuesPath}/${number}`, token }),
    read: (data) => {
      // A pull request has a number of the same kind: it is not an issue
      if (isPullRequest(data)) return null;
      const issue = issueFrom(data, defaultRepo);
      // An answer about another issue than the one asked for is no answer
      if (!issue || issue.number !== number) throw new BadResponse();
      const state = typeof data.state === 'string' ? data.state.toLowerCase() : null;
      return {
        kind: 'github_issue',
        repo: defaultRepo,
        issue: {
          ...issue,
          state: state === 'open' || state === 'closed' ? state : null,
          body: lines(data.body, MAX_BODY_SHOWN_CHARS) || '',
        },
      };
    },
  });

  // What is sent is what the owner saw on the sheet (`issueSheetBody`): the
  // title and the description, and no line of Arlo's own
  const createIssue = ({ title, body }) => ({
    send: (token) => rest.request({
      method: 'POST', path: issuesPath, body: body ? { title, body } : { title }, token,
    }),
    read: (data) => {
      // The new issue is one of this repository, with a number: nothing else is believed
      if (!isPlainObject(data) || !isIssueNumber(data.number)) throw new BadResponse();
      if (typeof data.html_url !== 'string' || data.html_url !== issueUrl(defaultRepo, data.number)) throw new BadResponse();
      return {
        kind: 'github_issue_created', repo: defaultRepo, number: data.number, title,
      };
    },
  });

  const RUN = { github_list_issues: listIssues, github_get_issue: getIssue, github_create_issue: createIssue };

  const stillConnected = (userId) => {
    try {
      return connections.status(userId).connected === true;
    } catch {
      return false;
    }
  };

  /**
   * Runs one of Arlo's tools as one user: { ok: true, result } or { ok: false, code }.
   * Codes: invalid_args and not_offered (nothing was sent), not_connected
   * (this user has no connection, or GitHub ended it), unauthorized (GitHub
   * refused the token), not_found (no such issue, or no access to it),
   * forbidden (no permission, or rate limited), refused (another 4xx), and
   * unreachable, timeout, bad_response. After github_create_issue, timeout,
   * unreachable and bad_response do not say that no issue was created.
   */
  async function call(name, args, { userId } = {}) {
    try {
      if (!TOOL_NAMES.includes(name)) return { ok: false, code: 'not_offered' };
      const read = readArgs(name, args);
      if (!read) return { ok: false, code: 'invalid_args' };
      if (typeof userId !== 'string' || userId.length === 0) return { ok: false, code: 'not_connected' };
      const run = RUN[name](read);

      // This user's token, held for this call and no longer
      const token = await connections.getAccessToken(userId);
      if (typeof token !== 'string') return { ok: false, code: 'not_connected' };
      let answer = await run.send(token);
      if (isPlainObject(answer) && answer.status === 401) {
        let next = null;
        try {
          next = await connections.refreshAccessToken(userId, token);
        } catch {
          next = null;
        }
        // A write is not sent a second time once it was sent
        if (!READ_TOOLS.has(name)) return { ok: false, code: stillConnected(userId) ? 'unauthorized' : 'not_connected' };
        if (typeof next !== 'string') return { ok: false, code: stillConnected(userId) ? 'unauthorized' : 'not_connected' };
        answer = await run.send(next);
        if (isPlainObject(answer) && answer.status === 401) {
          // A new token is refused as well: the connection is over
          connections.drop(userId);
          return { ok: false, code: 'not_connected' };
        }
      }
      if (!isPlainObject(answer) || !Number.isInteger(answer.status)) throw new BadResponse();
      if (answer.status !== 200 && answer.status !== 201) return { ok: false, code: failureOf(answer.status) };
      const result = run.read(answer.json);
      return result === null ? { ok: false, code: 'not_found' } : { ok: true, result };
    } catch (error) {
      const code = error && !(error instanceof BadResponse) && typeof error.code === 'string' ? error.code : 'bad_response';
      return { ok: false, code: ['unreachable', 'timeout'].includes(code) ? code : 'bad_response' };
    }
  }

  return { name: 'github', repo: defaultRepo, call };
}

module.exports = {
  createGithubConnector, readArgs, TOOL_NAMES, MAX_ISSUES, MAX_TITLE_CHARS, MAX_BODY_SENT_CHARS,
};
