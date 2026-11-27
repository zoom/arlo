/**
 * The calls to GitHub's REST API that the GitHub connector makes, as one
 * user: the issues of one repository, and nothing else.
 *
 *   GET  /repos/{owner}/{repo}/issues                   list repository issues
 *   GET  /repos/{owner}/{repo}/issues/{issue_number}    get an issue
 *   POST /repos/{owner}/{repo}/issues                   create an issue
 *
 * Endpoints, parameters and headers are GitHub's documented ones
 * (docs.github.com, "REST API endpoints for issues" and "API Versions", read
 * 2026-11-27): `Accept: application/vnd.github+json`, `Authorization: Bearer
 * <token>`, `X-GitHub-Api-Version: 2026-03-10`.
 *
 * SECURITY
 * - Calls go to https://api.github.com only. The path must be one of the
 *   three above, checked here whatever the caller built; a redirect is an
 *   error and is never followed (the token would travel with it).
 * - The token is one user's, given per call. It goes into the Authorization
 *   header of that one request and nowhere else: not into a URL, a log line or
 *   an error. Nothing here logs anything.
 * - Each call has a time limit (10 seconds, the body included) and its answer
 *   a size limit (200 KB unless the caller names another); a longer answer is
 *   dropped, never cut and parsed.
 * - Only the body of a 200 or 201 is read. What GitHub says with an error
 *   (it can quote the request) is never read, kept or passed on.
 *
 * request() -> { status, json } (json: the parsed body of a 200 / 201, null
 * for any other status). It throws a GithubRestError with a code: 'timeout',
 * 'unreachable' (also a redirect), 'bad_response' (too long, not JSON),
 * 'invalid' (not one of the calls above; nothing was sent).
 */
const { TOKEN } = require('./githubAuth');

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const CALL_TIMEOUT_MS = 10 * 1000;
const MAX_ANSWER_BYTES = 200 * 1024;
// The most a caller may ask for (the list: a page of issues comes with their bodies)
const MAX_ANSWER_BYTES_CEILING = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 20 * 1024;

// "/repos/owner/name/issues" or "/repos/owner/name/issues/42": the characters
// of a repository as lib/github.js accepts one, a number without a leading zero
const ISSUES_PATH = /^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues(?:\/[1-9][0-9]{0,6})?$/;
const QUERY_KEYS = new Set(['state', 'sort', 'direction', 'per_page', 'labels']);

class GithubRestError extends Error {
  constructor(code) {
    // The code and nothing else: a message could quote a request
    super(code);
    this.name = 'GithubRestError';
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The body as text, or a 'bad_response' when it is longer than `max` bytes. */
async function readBounded(response, max) {
  const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > max) throw new GithubRestError('bad_response');
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > max) throw new GithubRestError('bad_response');
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Not read to its end: whatever is still on its way is dropped
      reader.cancel().catch(() => {});
      throw new GithubRestError('bad_response');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function discard(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') response.body.cancel().catch(() => {});
  } catch {
    // Not reading an answer is best effort
  }
}

/** `fetch` and the limits are passed in so tests run without a network and without waiting. */
function createGithubRest({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CALL_TIMEOUT_MS,
  maxBytes = MAX_ANSWER_BYTES,
} = {}) {
  /**
   * One call as the user `token` belongs to.
   * @param method   'GET' | 'POST'
   * @param path     one of the three issue paths
   * @param query    for a GET: { state, sort, direction, per_page, labels }, strings and numbers only
   * @param body     for a POST: a JSON object
   * @param maxBytes another size limit for this answer, at most 2 MB
   */
  async function request({
    method, path, query, body, token, maxBytes: cap,
  } = {}) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new GithubRestError('invalid');
    if ((method !== 'GET' && method !== 'POST') || typeof path !== 'string' || !ISSUES_PATH.test(path)) throw new GithubRestError('invalid');
    const url = new URL(`${API_ORIGIN}${path}`);
    if (query !== undefined) {
      if (method !== 'GET' || !isPlainObject(query)) throw new GithubRestError('invalid');
      for (const [key, value] of Object.entries(query)) {
        const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
        if (!QUERY_KEYS.has(key) || typeof text !== 'string' || text.length === 0 || text.length > 200) throw new GithubRestError('invalid');
        url.searchParams.set(key, text);
      }
    }
    // What was built is what is called: this host, this path, https
    if (url.origin !== API_ORIGIN || url.pathname !== path || url.username || url.password || url.hash) throw new GithubRestError('invalid');
    let sent;
    if (method === 'POST') {
      // A POST only creates: to the list path, never to one issue's
      if (!isPlainObject(body) || /\/issues\/[0-9]+$/.test(path)) throw new GithubRestError('invalid');
      sent = JSON.stringify(body);
      if (Buffer.byteLength(sent, 'utf8') > MAX_BODY_BYTES) throw new GithubRestError('invalid');
    } else if (body !== undefined) {
      throw new GithubRestError('invalid');
    }
    const limit = Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, MAX_ANSWER_BYTES_CEILING) : maxBytes;

    const controller = new AbortController();
    let timer;
    // The limit holds whatever the call does: also one that does not end when it is aborted
    const tooLong = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GithubRestError('timeout'));
      }, timeoutMs);
    });
    const answered = (async () => {
      const response = await fetchImpl(url.href, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(sent !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(sent !== undefined && { body: sent }),
        redirect: 'error',
        signal: controller.signal,
      });
      const status = response && Number.isInteger(response.status) ? response.status : 0;
      if (status !== 200 && status !== 201) {
        discard(response);
        if (status < 100 || status > 599) throw new GithubRestError('bad_response');
        return { status, json: null };
      }
      const text = await readBounded(response, limit);
      try {
        return { status, json: JSON.parse(text) };
      } catch {
        throw new GithubRestError('bad_response');
      }
    })();
    // When the time is up first, what the call still does is nobody's to wait for
    answered.catch(() => {});
    try {
      return await Promise.race([answered, tooLong]);
    } catch (error) {
      if (controller.signal.aborted || (error && error.name === 'AbortError')) throw new GithubRestError('timeout');
      if (error instanceof GithubRestError) throw error;
      // Whatever went wrong on the way (also a redirect): its message is not kept
      throw new GithubRestError('unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return { request };
}

module.exports = {
  createGithubRest, GithubRestError, API_ORIGIN, API_VERSION, CALL_TIMEOUT_MS, MAX_ANSWER_BYTES,
};
