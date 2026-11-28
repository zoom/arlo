/**
 * Each connected user's GitHub connection (their tokens), by Arlo user id.
 * The plan calls this file githubTokens.js.
 *
 * In memory only, and encrypted there (AES-256-GCM with TOKEN_ENCRYPTION_KEY,
 * the same helper that encrypts the Zoom tokens): one blob per user holds the
 * access token, the refresh token, their expiry times, the GitHub login and
 * the GitHub user id. A restart means connecting again. They are never put in
 * the sessionRestore cookie.
 *
 * A connection is removed on Disconnect, on Arlo logout, on app_deauthorized,
 * when GitHub refuses a refresh or keeps refusing the token (drop()), and when
 * the store is full (1000 users: the one connected longest ago goes). A
 * removal the user did not ask for is told to `onRemoved(userId)`, so their
 * open panels can be told (`connectors.updated`).
 *
 * Disconnect, logout and app_deauthorized also ask GitHub to delete the grant
 * (disconnectGithubUser): best effort, never waited for by a logout, and a
 * failure is logged as a code only.
 *
 * Tokens that are valid at GitHub and that nobody here holds any more are
 * revoked too (`onDiscarded`, best effort):
 * - a connection pushed out because the store was full, and one replaced by
 *   a connection to another GitHub account: the grant, as on Disconnect;
 * - the tokens of a refresh that landed after its connection was gone
 *   (replaced or removed meanwhile): that one token. The same person may
 *   hold a new connection to the same GitHub account by then, and deleting
 *   the grant would end it.
 * Connecting the same GitHub account again revokes nothing: the grant is the
 * one the new tokens belong to.
 *
 * SECURITY
 * - Nothing here logs a token, a login or a user id.
 * - A token is handed out only by getAccessToken(userId) and
 *   refreshAccessToken(userId, …), for that one user, and by take(userId) to
 *   the one function that revokes the grant. status(userId) says whether they
 *   are connected and as whom, never a token.
 * - GitHub ends the old access token and refresh token the moment a refresh
 *   token is used, so a refresh runs once per user at a time (single flight)
 *   and every waiting caller gets its answer. For the same reason a
 *   Disconnect or logout that comes while a refresh runs waits for it and
 *   revokes with what it brought (take() hands out `refreshed`).
 */
const { TOKEN, LOGIN } = require('./githubAuth');

const MAX_USERS = 1000;
// A token that runs out within this time is refreshed before it is handed out
const REFRESH_AHEAD_MS = 60 * 1000;

const isShaped = (value, shape) => typeof value === 'string' && shape.test(value);
const isTime = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * A store. `encrypt` / `decrypt` are the project's token helpers; `refresh`
 * asks GitHub for new tokens (githubAuth.refresh); `now` is the clock.
 */
function createGithubConnections({
  encrypt, decrypt, refresh, now = () => Date.now(), maxUsers = MAX_USERS,
  // (userId): a connection went without its user asking for it
  onRemoved = () => {},
  // (held, { whole }): tokens that work at GitHub and that the store no longer
  // holds. `whole`: the connection is over (the grant goes); otherwise only
  // this one token. Must not throw; nothing is waited for
  onDiscarded = () => {},
} = {}) {
  const connections = new Map(); // userId -> { blob }
  // userId -> { flight: Promise<string | null>, entry, claimed, landed: Promise<held | null>, hand }
  const refreshing = new Map();

  const heldOf = (record) => ({
    accessToken: record.accessToken, expiresAt: record.expiresAt, refreshToken: record.refreshToken, refreshExpiresAt: record.refreshExpiresAt,
  });

  function discard(held, whole) {
    try {
      onDiscarded(held, { whole });
    } catch {
      // Revoking is best effort: it never changes what the store did
    }
  }

  /**
   * A connection that is over without its user asking (pushed out, or
   * replaced by another GitHub account): its grant is revoked. While a
   * refresh runs for it GitHub may be ending these very tokens, so that
   * waits for the refresh and uses what it brought.
   */
  function discardConnection(userId, entry, record) {
    if (!wellFormed(record)) return;
    const running = refreshing.get(userId);
    if (running && running.entry === entry && !running.claimed) {
      running.over = heldOf(record);
      return;
    }
    discard(heldOf(record), true);
  }

  /** Remove a connection its user did not ask to remove, and say so. */
  function lose(userId) {
    if (!connections.delete(userId)) return false;
    try {
      onRemoved(userId);
    } catch {
      // Telling a panel must never undo a removal
    }
    return true;
  }

  function open(entry) {
    try {
      return JSON.parse(decrypt(entry.blob));
    } catch {
      return null;
    }
  }

  function seal(record) {
    return {
      blob: encrypt(JSON.stringify({
        accessToken: record.accessToken,
        expiresAt: record.expiresAt,
        refreshToken: record.refreshToken,
        refreshExpiresAt: record.refreshExpiresAt,
        login: record.login,
        githubUserId: record.githubUserId,
      })),
    };
  }

  const wellFormed = (record) => record !== null && typeof record === 'object'
    && isShaped(record.accessToken, TOKEN) && isShaped(record.refreshToken, TOKEN)
    && isTime(record.expiresAt) && isTime(record.refreshExpiresAt)
    && isShaped(record.login, LOGIN) && Number.isSafeInteger(record.githubUserId) && record.githubUserId > 0;

  /** Keep this user's connection. False (and nothing kept) when a field is not what it must be. */
  function set(userId, record) {
    if (typeof userId !== 'string' || userId.length === 0 || !wellFormed(record)) return false;
    const before = connections.get(userId);
    const replaced = before ? open(before) : null;
    // Set again: the newest connection is the last to be dropped
    connections.delete(userId);
    while (connections.size >= maxUsers) {
      const oldest = connections.keys().next().value;
      const oldestEntry = connections.get(oldest);
      lose(oldest);
      // Its tokens still work at GitHub and nobody holds them now
      discardConnection(oldest, oldestEntry, open(oldestEntry));
    }
    connections.set(userId, seal(record));
    // Another GitHub account than before: the old one's connection is over.
    // The same account: its grant is the one the new tokens belong to
    if (wellFormed(replaced) && replaced.githubUserId !== record.githubUserId) discardConnection(userId, before, replaced);
    return true;
  }

  /** Forget this user's connection. True when there was one. */
  function remove(userId) {
    return connections.delete(userId);
  }

  /**
   * Forget this user's connection and hand back what it held, for the one
   * caller that revokes the grant at GitHub: `{ accessToken, expiresAt,
   * refreshToken, refreshExpiresAt }`, or null when there was none.
   *
   * While a refresh runs for this connection, GitHub may already have ended
   * these tokens and issued new ones. The answer then also has `refreshed`:
   * a promise (it never rejects, and is over when the refresh is, which has
   * a time limit of its own) of the new tokens in the same shape, or of null
   * when the refresh brought none. The caller revokes with those.
   */
  function take(userId) {
    const entry = connections.get(userId);
    if (!entry) return null;
    connections.delete(userId);
    const record = open(entry);
    if (!wellFormed(record)) return null;
    const running = refreshing.get(userId);
    const refreshed = running && running.entry === entry ? running.landed : null;
    // Whoever took the connection gets the new tokens: they are not revoked twice
    if (refreshed) running.claimed = true;
    return { ...heldOf(record), ...(refreshed && { refreshed }) };
  }

  /** GitHub keeps refusing this user's token: the connection is over, and their panels are told. */
  function drop(userId) {
    return lose(userId);
  }

  /** `{ connected, login }` for this user. Never a token. */
  function status(userId) {
    const entry = connections.get(userId);
    const record = entry ? open(entry) : null;
    if (!record) return { connected: false, login: null };
    return { connected: true, login: record.login };
  }

  /** `forced`: the old token was refused by GitHub, so it is never the answer. */
  async function refreshFor(userId, entry, record, forced, running) {
    let result;
    try {
      result = await refresh(record.refreshToken);
    } catch {
      result = { ok: false, code: 'unreachable', refused: false };
    }
    // Disconnected or connected anew while GitHub was asked: that decision stands
    if (connections.get(userId) !== entry) {
      // GitHub may have issued new tokens all the same, and ended the old ones.
      // They go to whoever took the connection to revoke it; when nobody did
      // (replaced by a new connection), the new token is revoked from here
      const next = result && result.ok === true ? { ...record, ...result.tokens } : null;
      const landed = wellFormed(next) ? heldOf(next) : null;
      if (running.claimed) running.hand(landed);
      // A connection that was over (discardConnection): its grant, with the
      // new tokens or, when the refresh brought none, the ones it had
      else if (running.over) discard(landed || running.over, true);
      else if (landed) discard(landed, false);
      return null;
    }
    if (result && result.ok === true) {
      const next = { ...record, ...result.tokens };
      if (wellFormed(next)) {
        // In place: a refresh is not a new connection, its turn to be dropped stays
        entry.blob = seal(next).blob;
        return next.accessToken;
      }
      lose(userId);
      return null;
    }
    if (!result || result.refused !== false) {
      // GitHub said no: the connection is over
      lose(userId);
      return null;
    }
    // GitHub could not be asked. The old token works until it runs out
    return !forced && record.expiresAt > now() ? record.accessToken : null;
  }

  /** One refresh per user at a time: whoever asks meanwhile gets the same answer. */
  function refreshOnce(userId, entry, record, forced) {
    const before = refreshing.get(userId);
    if (before) return before.flight;
    const running = { entry, claimed: false };
    running.landed = new Promise((resolve) => { running.hand = resolve; });
    running.flight = refreshFor(userId, entry, record, forced, running).finally(() => {
      if (refreshing.get(userId) === running) refreshing.delete(userId);
    });
    refreshing.set(userId, running);
    return running.flight;
  }

  /**
   * A token that works for this user's GitHub, or null when they are not
   * connected (any more). Refreshed first when it runs out within a minute.
   */
  async function getAccessToken(userId) {
    const entry = connections.get(userId);
    if (!entry) return null;
    const record = open(entry);
    if (!wellFormed(record)) {
      lose(userId);
      return null;
    }
    if (record.expiresAt - now() > REFRESH_AHEAD_MS) return record.accessToken;
    if (record.refreshExpiresAt <= now()) {
      lose(userId);
      return null;
    }
    return refreshOnce(userId, entry, record, false);
  }

  /**
   * GitHub answered 401 to `refusedToken`, which getAccessToken() had handed
   * out for this user: a new token, or null. When the connection holds
   * another token by now (someone else's call refreshed it), that one is the
   * answer and nothing is asked. null: not connected (any more), or GitHub
   * could not be asked for a new one (the connection is kept then).
   */
  async function refreshAccessToken(userId, refusedToken) {
    const entry = connections.get(userId);
    if (!entry) return null;
    const record = open(entry);
    if (!wellFormed(record)) {
      lose(userId);
      return null;
    }
    if (typeof refusedToken === 'string' && record.accessToken !== refusedToken) return record.accessToken;
    if (record.refreshExpiresAt <= now()) {
      lose(userId);
      return null;
    }
    const token = await refreshOnce(userId, entry, record, true);
    // A refresh that was already running for another caller may hand back the
    // old token (GitHub could not be asked): to this caller it is the refused one
    return token === refusedToken ? null : token;
  }

  return {
    set, remove, take, drop, status, getAccessToken, refreshAccessToken, size: () => connections.size,
  };
}

let store; // one per process

/** The deployment's store. */
function getGithubConnections() {
  if (store === undefined) {
    /* eslint-disable global-require */
    const { encryptToken, decryptToken } = require('../auth');
    const { getGithubAuth } = require('./githubAuth');
    /* eslint-enable global-require */
    store = createGithubConnections({
      encrypt: encryptToken,
      decrypt: decryptToken,
      // Asked for at the time of the call: tests put another flow in place
      refresh: (refreshToken) => getGithubAuth().refresh(refreshToken),
      onRemoved: tellPanels,
      onDiscarded: discardAtGithub,
    });
  }
  return store;
}

/** The user's own open panels read GET /api/connectors again. Never throws. */
function tellPanels(userId) {
  try {
    // Required here: the socket server's neighbours require this module's neighbours
    // eslint-disable-next-line global-require
    require('../websocket').sendConnectorsUpdated(userId);
  } catch {
    // A panel that cannot be told must not change what was removed
  }
}

/**
 * Ask GitHub to delete the grant these tokens belong to (`whole`), or only
 * their access token: `{ ok: true }` or `{ ok: false, code }`. Revoking needs
 * an access token that still works, so one that has run out is refreshed
 * first. Never throws.
 */
async function revokeAtGithub(held, now = Date.now(), { whole = true } = {}) {
  try {
    // eslint-disable-next-line global-require
    const auth = require('./githubAuth').getGithubAuth();
    let { accessToken } = held;
    if (held.expiresAt <= now) {
      const refreshed = held.refreshExpiresAt > now ? await auth.refresh(held.refreshToken) : null;
      if (!refreshed || refreshed.ok !== true) return { ok: false, code: 'no_token' };
      accessToken = refreshed.tokens.accessToken;
    }
    const revoked = whole ? await auth.revokeGrant(accessToken) : await auth.revokeToken(accessToken);
    return revoked && revoked.ok === true ? { ok: true } : { ok: false, code: revoked && typeof revoked.code === 'string' ? revoked.code : 'error' };
  } catch {
    return { ok: false, code: 'error' };
  }
}

const codeOf = (outcome) => (outcome && typeof outcome.code === 'string' && /^[a-z_]{1,40}$/.test(outcome.code) ? outcome.code : 'error');

/**
 * Tokens the store let go of while they still work at GitHub (see the top of
 * this file): revoked there, best effort and not waited for. A failure is
 * logged as a code, never a token, a login or a user id. Never throws.
 */
function discardAtGithub(held, { whole = false } = {}, { log = console } = {}) {
  return revokeAtGithub(held, Date.now(), { whole }).catch(() => ({ ok: false, code: 'error' })).then((outcome) => {
    if (!outcome.ok) {
      try {
        log.warn(`GitHub: a token that was not kept was not revoked at GitHub (${codeOf(outcome)})`);
      } catch {
        // A log that fails changes nothing
      }
    }
    return outcome;
  });
}

/**
 * End a user's GitHub connection: Disconnect, logout, app_deauthorized. At
 * once and before anything is awaited: the connection is gone from memory,
 * and so is a connect flow they had started (its callback then stores
 * nothing). Then GitHub is asked to delete the grant, best effort: a failure
 * is logged as a code, never a token, a login or a user id.
 *
 * A refresh that runs for this connection right now may already have made
 * GitHub end the tokens that were held: it is waited for (it has a time
 * limit of its own), and the grant is revoked with the tokens it brought.
 *
 * -> { wasConnected, revoked }: `revoked` is a promise that never rejects,
 * for a caller that wants to wait (Disconnect); logout does not.
 */
function disconnectGithubUser(userId, { log = console } = {}) {
  // eslint-disable-next-line global-require
  require('./githubAuth').getGithubAuth().forgetUser(userId);
  const connections = getGithubConnections();
  const wasConnected = connections.status(userId).connected;
  const held = connections.take(userId);
  const revoked = (async () => {
    if (!wasConnected) return { ok: true };
    // With what the running refresh brought, when it brought something: the
    // tokens taken above are then no longer GitHub's
    const fresh = held && held.refreshed ? await held.refreshed : null;
    const outcome = held ? await revokeAtGithub(fresh || held) : { ok: false, code: 'no_token' };
    // A code from this file's and githubAuth's fixed lists
    if (!outcome.ok) log.warn(`GitHub disconnect: the grant was not revoked at GitHub (${codeOf(outcome)})`);
    return outcome;
  })().catch(() => ({ ok: false, code: 'error' }));
  return { wasConnected, revoked };
}

/**
 * A user signed out or removed the app: their GitHub connection goes, and so
 * does a connect flow they had started. GitHub is asked to delete the grant
 * too, and that is not waited for: signing out never hangs on GitHub. True
 * when there was a connection.
 */
function forgetGithubUser(userId) {
  return disconnectGithubUser(userId).wasConnected;
}

/** Tests: put another store in place, or none. */
function _setForTests(replacement) {
  store = replacement;
}

module.exports = {
  createGithubConnections, getGithubConnections, forgetGithubUser, disconnectGithubUser, discardAtGithub, tellPanels, _setForTests, MAX_USERS,
};
