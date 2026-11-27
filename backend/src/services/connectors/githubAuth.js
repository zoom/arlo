/**
 * "Connect GitHub": the flow that ties one signed-in Arlo user to their own
 * GitHub account, through a GitHub App's user authorization (web flow).
 *
 * The panel runs inside Zoom; GitHub's pages open in the system browser, which
 * has no Arlo session. So three short-lived things carry the flow across:
 *
 *   ticket  issued to the signed-in panel, 5 minutes, one use, at most 3 open
 *           per user. It opens the start page in the browser, which names
 *           whose Arlo is being connected and needs a click.
 *   cookie  `ghConnect`, set in that browser when the start page is shown. It
 *           ties the rest of the flow to that browser.
 *   state   made when the ticket is used, 10 minutes, one use. Bound to the
 *           user, to the cookie and to a PKCE verifier. GitHub hands it back
 *           on the callback.
 *
 * Tickets and states are kept as sha256 hashes: what is in memory cannot be
 * replayed. Everything is in memory and gone with a restart.
 *
 * Endpoints and parameters are GitHub's documented ones (docs.github.com,
 * "Generating a user access token for a GitHub App", "Refreshing user access
 * tokens", "REST API endpoints for OAuth authorizations", read 2026-11-27):
 * PKCE with S256 is documented for GitHub Apps and is used.
 *
 * SECURITY
 * - A token, refresh token, code, state, ticket and the client secret are
 *   secrets: nothing here logs one or puts one in an error. What a caller can
 *   log is a code from a fixed list (`{ ok: false, code }`).
 * - Calls go to https://github.com and https://api.github.com only, with a
 *   time limit, and no redirect is followed.
 * - Everything GitHub answers is untrusted: bounded, parsed, and rebuilt from
 *   the fields that are known, each checked for its shape.
 */
const crypto = require('crypto');

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const grantUrl = (clientId) => `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`;
const CALLBACK_PATH = '/api/connectors/github/callback';
const START_PATH = '/api/connectors/github/start';
const API_VERSION = '2026-03-10';

const TICKET_TTL_MS = 5 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_TICKETS_PER_USER = 3;
const MAX_TICKETS = 5000;
const MAX_STATES = 5000;
const CALL_TIMEOUT_MS = 10 * 1000;
const MAX_ANSWER_CHARS = 20000;

// 32 random bytes as base64url
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{10,200}$/;
// A GitHub token ("ghu_…", "ghr_…"): letters, digits and "_"
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
// A GitHub login: letters, digits and dashes (an enterprise-managed one has a "_")
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const MAX_LIFETIME_SECONDS = 2 * 365 * 24 * 60 * 60;

// What GitHub's token endpoint answers in `error` (its documented names).
// Anything else it says is not repeated: the code is then 'refused'
const TOKEN_ERRORS = new Set([
  'bad_verification_code', 'incorrect_client_credentials', 'redirect_uri_mismatch',
  'unverified_user_email', 'bad_refresh_token',
]);

const isShaped = (value, shape) => typeof value === 'string' && shape.test(value);
const randomValue = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();
const hashKey = (text) => sha256(text).toString('hex');
const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const isLifetime = (value) => Number.isInteger(value) && value > 0 && value <= MAX_LIFETIME_SECONDS;

/**
 * The flow for one GitHub App. `fetch` and `now` are passed in so tests run
 * without a network and without waiting.
 */
function createGithubAuth({
  clientId, clientSecret, publicUrl,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  const tickets = new Map(); // sha256(ticket) -> { userId, expiresAt }
  const states = new Map(); // sha256(state) -> { userId, cookieHash, codeVerifier, expiresAt }
  const callbacks = new Set(); // callbacks that are asking GitHub right now: { userId, cancelled }
  const available = Boolean(clientId && clientSecret && publicUrl);
  const redirectUri = `${String(publicUrl || '').replace(/\/+$/, '')}${CALLBACK_PATH}`;

  function prune(map) {
    const at = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= at) map.delete(key);
    }
  }

  /** Keep `map` under `max` entries: the oldest go first (a Map keeps insertion order). */
  function makeRoom(map, max) {
    while (map.size >= max) map.delete(map.keys().next().value);
  }

  /**
   * A ticket for this user: the value to put in the start link, or null when
   * there is no user id. A user holds at most 3 open tickets; a further one
   * replaces their oldest.
   */
  function issueTicket(userId) {
    if (typeof userId !== 'string' || userId.length === 0) return null;
    prune(tickets);
    const own = [...tickets].filter(([, entry]) => entry.userId === userId);
    while (own.length >= MAX_TICKETS_PER_USER) tickets.delete(own.shift()[0]);
    makeRoom(tickets, MAX_TICKETS);
    const ticket = randomValue();
    tickets.set(hashKey(ticket), { userId, expiresAt: now() + TICKET_TTL_MS });
    return ticket;
  }

  function readTicket(ticket, { consume }) {
    if (!isShaped(ticket, RANDOM_VALUE)) return null;
    const key = hashKey(ticket);
    const entry = tickets.get(key);
    if (!entry) return null;
    if (consume || entry.expiresAt <= now()) tickets.delete(key);
    return entry.expiresAt > now() ? { userId: entry.userId } : null;
  }

  /** Whose ticket this is, without using it up: `{ userId }` or null. */
  const peekTicket = (ticket) => readTicket(ticket, { consume: false });
  /** Whose ticket this is, used up by asking: `{ userId }` or null. */
  const consumeTicket = (ticket) => readTicket(ticket, { consume: true });

  /**
   * A state for this user in the browser that holds `cookieValue`, and the
   * GitHub URL to send that browser to: `{ state, url }`, or null.
   */
  function createState({ userId, cookieValue }) {
    if (!available || typeof userId !== 'string' || userId.length === 0 || !isShaped(cookieValue, RANDOM_VALUE)) return null;
    prune(states);
    makeRoom(states, MAX_STATES);
    const state = randomValue();
    const codeVerifier = randomValue();
    states.set(hashKey(state), {
      userId, cookieHash: sha256(cookieValue), codeVerifier, expiresAt: now() + STATE_TTL_MS,
    });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    // An expiring token with a refresh token, whatever the app's own setting
    url.searchParams.set('scope', 'offline_access');
    url.searchParams.set('code_challenge', sha256(codeVerifier).toString('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    // GitHub's account picker, every time ("Forces the account picker to
    // appear if set to select_account"): the person sees which GitHub account
    // is about to be connected, and picks it. It limits the account mix-up
    // (routes/connectors.js); it does not prevent it
    url.searchParams.set('prompt', 'select_account');
    return { state, url: url.href };
  }

  /**
   * The state GitHub handed back, used up by asking (a second callback with
   * it finds nothing). `{ userId, codeVerifier, end }` only when it is known, not
   * expired, and this browser's cookie is the one it was made for. The caller
   * calls `end()` when it is done.
   */
  function consumeState(state, cookieValue) {
    if (!isShaped(state, RANDOM_VALUE)) return null;
    const key = hashKey(state);
    const entry = states.get(key);
    if (!entry) return null;
    states.delete(key);
    if (entry.expiresAt <= now()) return null;
    if (!isShaped(cookieValue, RANDOM_VALUE) || !sameBytes(sha256(cookieValue), entry.cookieHash)) return null;
    // From here until end() the callback is asking GitHub. A user who signs
    // out meanwhile (forgetUser) must not get a connection after all
    const running = { userId: entry.userId, cancelled: false };
    while (callbacks.size >= MAX_STATES) {
      const oldest = callbacks.values().next().value;
      oldest.cancelled = true;
      callbacks.delete(oldest);
    }
    callbacks.add(running);
    return {
      userId: entry.userId,
      codeVerifier: entry.codeVerifier,
      /** The callback is over. True when its user is still to be connected. */
      end: () => {
        callbacks.delete(running);
        return !running.cancelled;
      },
    };
  }

  /** Drop what is open for a user (they signed out, or removed the app). */
  function forgetUser(userId) {
    for (const map of [tickets, states]) {
      for (const [key, entry] of map) {
        if (entry.userId === userId) map.delete(key);
      }
    }
    for (const running of callbacks) {
      if (running.userId === userId) running.cancelled = true;
    }
  }

  /**
   * One call to GitHub: `{ status, json }`, or `{ failed: code }`. No redirect
   * is followed, the answer is bounded, and nothing of it is logged.
   */
  async function call(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
      const text = await response.text();
      if (text.length > MAX_ANSWER_CHARS) return { failed: 'bad_response' };
      let json = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          return { status: response.status, json: null };
        }
      }
      return { status: response.status, json };
    } catch (error) {
      return { failed: controller.signal.aborted || (error && error.name === 'AbortError') ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** GitHub's answer to a token request, rebuilt: `{ ok: true, tokens }` or `{ ok: false, code }`. */
  function readTokenAnswer(answer) {
    if (answer.failed) return { ok: false, code: answer.failed };
    const body = answer.json;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'bad_response' };
    if (body.error !== undefined) {
      return { ok: false, code: typeof body.error === 'string' && TOKEN_ERRORS.has(body.error) ? body.error : 'refused' };
    }
    if (answer.status !== 200) return { ok: false, code: 'refused' };
    const tokenType = typeof body.token_type === 'string' ? body.token_type.toLowerCase() : null;
    if (!isShaped(body.access_token, TOKEN) || !isShaped(body.refresh_token, TOKEN) || tokenType !== 'bearer'
      || !isLifetime(body.expires_in) || !isLifetime(body.refresh_token_expires_in)) {
      // Also a token that does not expire (no refresh token): not kept
      return { ok: false, code: 'bad_response' };
    }
    const at = now();
    return {
      ok: true,
      tokens: {
        accessToken: body.access_token,
        expiresAt: at + body.expires_in * 1000,
        refreshToken: body.refresh_token,
        refreshExpiresAt: at + body.refresh_token_expires_in * 1000,
      },
    };
  }

  // The client secret travels in the body of a POST to github.com, never in a URL
  const tokenRequest = (fields) => call(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }).toString(),
  });

  /** Exchange the callback's code: `{ ok: true, tokens }` or `{ ok: false, code }`. */
  async function exchangeCode({ code, codeVerifier }) {
    if (!available) return { ok: false, code: 'not_available' };
    if (!isShaped(code, CODE) || !isShaped(codeVerifier, RANDOM_VALUE)) return { ok: false, code: 'bad_request' };
    return readTokenAnswer(await tokenRequest({ code, redirect_uri: redirectUri, code_verifier: codeVerifier }));
  }

  /**
   * New tokens for a refresh token: `{ ok: true, tokens }` or `{ ok: false,
   * code, refused }`. `refused` is true when GitHub answered and said no (the
   * connection is over); false when it could not be asked (try again later).
   */
  async function refresh(refreshToken) {
    if (!available) return { ok: false, code: 'not_available', refused: false };
    if (!isShaped(refreshToken, TOKEN)) return { ok: false, code: 'bad_request', refused: true };
    const answer = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const result = readTokenAnswer(answer);
    if (result.ok) return result;
    const couldNotAsk = Boolean(answer.failed) || answer.status >= 500;
    return { ...result, refused: !couldNotAsk };
  }

  /** Whose token this is: `{ ok: true, login, githubUserId }` or `{ ok: false, code }`. */
  async function fetchUser(accessToken) {
    if (!isShaped(accessToken, TOKEN)) return { ok: false, code: 'bad_request' };
    const answer = await call(USER_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
    if (answer.failed) return { ok: false, code: answer.failed };
    if (answer.status !== 200) return { ok: false, code: 'refused' };
    const body = answer.json;
    if (body === null || typeof body !== 'object' || !isShaped(body.login, LOGIN)
      || !Number.isSafeInteger(body.id) || body.id <= 0) {
      return { ok: false, code: 'bad_response' };
    }
    return { ok: true, login: body.login, githubUserId: body.id };
  }

  /**
   * Ask GitHub to delete this user's grant for the app (all their tokens for
   * it): `{ ok: true }` or `{ ok: false, code }`. Basic authentication with
   * the app's client ID and secret, as GitHub's reference says.
   */
  async function revokeGrant(accessToken) {
    if (!available) return { ok: false, code: 'not_available' };
    if (!isShaped(accessToken, TOKEN)) return { ok: false, code: 'bad_request' };
    const answer = await call(grantUrl(clientId), {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (answer.failed) return { ok: false, code: answer.failed };
    return answer.status === 204 ? { ok: true } : { ok: false, code: 'refused' };
  }

  return {
    available,
    issueTicket,
    peekTicket,
    consumeTicket,
    createState,
    consumeState,
    forgetUser,
    exchangeCode,
    refresh,
    fetchUser,
    revokeGrant,
  };
}

let auth; // one per process

/** The deployment's connect flow. `available` is false when the GitHub App or the repository is not set. */
function getGithubAuth() {
  if (auth === undefined) {
    // eslint-disable-next-line global-require
    const config = require('../../config');
    const on = config.githubConnectAvailable;
    auth = createGithubAuth({
      clientId: on ? config.githubAppClientId : null,
      clientSecret: on ? config.githubAppClientSecret : null,
      publicUrl: config.publicUrl,
    });
  }
  return auth;
}

/** Tests: put another flow in place (a fake `fetch`, a fake clock), or none. */
function _setForTests(replacement) {
  auth = replacement;
}

module.exports = {
  createGithubAuth, getGithubAuth, _setForTests,
  START_PATH, CALLBACK_PATH, RANDOM_VALUE, CODE, TOKEN, LOGIN,
  TICKET_TTL_MS, STATE_TTL_MS,
};
