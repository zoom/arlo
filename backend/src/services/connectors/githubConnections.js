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
 * when GitHub refuses a refresh, and when the store is full (1000 users: the
 * one connected longest ago goes).
 *
 * SECURITY
 * - Nothing here logs a token, a login or a user id.
 * - A token is handed out only by getAccessToken(userId), for that one user.
 *   status(userId) says whether they are connected and as whom, never a token.
 * - GitHub ends the old access token and refresh token the moment a refresh
 *   token is used, so a refresh runs once per user at a time (single flight)
 *   and every waiting caller gets its answer.
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
} = {}) {
  const connections = new Map(); // userId -> { blob }
  const refreshing = new Map(); // userId -> Promise<string | null>

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
    // Set again: the newest connection is the last to be dropped
    connections.delete(userId);
    while (connections.size >= maxUsers) connections.delete(connections.keys().next().value);
    connections.set(userId, seal(record));
    return true;
  }

  /** Forget this user's connection. True when there was one. */
  function remove(userId) {
    return connections.delete(userId);
  }

  /** `{ connected, login }` for this user. Never a token. */
  function status(userId) {
    const entry = connections.get(userId);
    const record = entry ? open(entry) : null;
    if (!record) return { connected: false, login: null };
    return { connected: true, login: record.login };
  }

  async function refreshFor(userId, entry, record) {
    let result;
    try {
      result = await refresh(record.refreshToken);
    } catch {
      result = { ok: false, code: 'unreachable', refused: false };
    }
    // Disconnected or connected anew while GitHub was asked: that decision stands
    if (connections.get(userId) !== entry) return null;
    if (result && result.ok === true) {
      const next = { ...record, ...result.tokens };
      if (wellFormed(next)) {
        // In place: a refresh is not a new connection, its turn to be dropped stays
        entry.blob = seal(next).blob;
        return next.accessToken;
      }
      connections.delete(userId);
      return null;
    }
    if (!result || result.refused !== false) {
      // GitHub said no: the connection is over
      connections.delete(userId);
      return null;
    }
    // GitHub could not be asked. The old token works until it runs out
    return record.expiresAt > now() ? record.accessToken : null;
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
      connections.delete(userId);
      return null;
    }
    if (record.expiresAt - now() > REFRESH_AHEAD_MS) return record.accessToken;
    if (record.refreshExpiresAt <= now()) {
      connections.delete(userId);
      return null;
    }
    const running = refreshing.get(userId);
    if (running) return running;
    const flight = refreshFor(userId, entry, record).finally(() => {
      if (refreshing.get(userId) === flight) refreshing.delete(userId);
    });
    refreshing.set(userId, flight);
    return flight;
  }

  return {
    set, remove, status, getAccessToken, size: () => connections.size,
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
    });
  }
  return store;
}

/**
 * A user signed out or removed the app: their GitHub connection goes, and so
 * does a connect flow they had started (its callback then stores nothing).
 */
function forgetGithubUser(userId) {
  // eslint-disable-next-line global-require
  require('./githubAuth').getGithubAuth().forgetUser(userId);
  return getGithubConnections().remove(userId);
}

/** Tests: put another store in place, or none. */
function _setForTests(replacement) {
  store = replacement;
}

module.exports = {
  createGithubConnections, getGithubConnections, forgetGithubUser, _setForTests, MAX_USERS,
};
