/**
 * Short-lived API tokens.
 *
 * A credential for scripts and tools, so nobody has to copy a browser session
 * cookie into a terminal. A signed-in user creates one, sees it once, and the
 * caller sends it as `Authorization: Bearer arlo_…`.
 *
 * - The token is 32 random bytes. Only its SHA-256 hash is kept, so reading
 *   this store does not yield a usable token.
 * - In memory only: a server restart revokes every token.
 * - Each token has scopes, an owner, an expiry (1 hour by default, 24 at most)
 *   and can be revoked. A user holds at most five at a time.
 * - It is a separate credential kind: it is not a session token, a
 *   meeting-access token or a restore cookie, and none of those work as one.
 */
const crypto = require('crypto');

const PREFIX = 'arlo_';
const SCOPES = Object.freeze({
  'rtms:control': 'Start, stop, pause and resume a stream through Zoom\'s REST API',
  'rtms:read': 'Read the timeline of RTMS events for your own meetings',
});
const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 24 * 60;
const MAX_PER_USER = 5;
const MAX_NAME_CHARS = 80;

const byHash = new Map(); // sha256(token) -> record

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isLive = (record) => record.expiresAt > Date.now();

function prune() {
  for (const [hash, record] of byHash) {
    if (!isLive(record)) byHash.delete(hash);
  }
}

const liveTokensOf = (userId) => [...byHash.values()].filter((r) => r.userId === userId && isLive(r));

/** What a caller may see about a token. Never the token or its hash. */
const describe = (record) => ({
  id: record.id,
  name: record.name,
  scopes: record.scopes,
  createdAt: new Date(record.createdAt).toISOString(),
  expiresAt: new Date(record.expiresAt).toISOString(),
  lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
});

/** Returns an error message for bad input, or null. */
function validate({ name, scopes, ttlMinutes }) {
  if (!Array.isArray(scopes) || scopes.length === 0) return 'scopes must be a non-empty list';
  if (!scopes.every((scope) => typeof scope === 'string' && Object.hasOwn(SCOPES, scope))) {
    return `scopes must be among: ${Object.keys(SCOPES).join(', ')}`;
  }
  if (ttlMinutes !== undefined
      && !(Number.isInteger(ttlMinutes) && ttlMinutes >= 1 && ttlMinutes <= MAX_TTL_MINUTES)) {
    return `ttlMinutes must be a whole number from 1 to ${MAX_TTL_MINUTES}`;
  }
  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_NAME_CHARS)) {
    return `name must be text of at most ${MAX_NAME_CHARS} characters`;
  }
  return null;
}

/**
 * Create a token. Returns { token, ...description }, or { error: 'limit' }
 * when the user already holds the maximum. The token is returned here once
 * and cannot be recovered afterwards.
 */
function create({ userId, zoomUserId, name, scopes, ttlMinutes = DEFAULT_TTL_MINUTES }) {
  prune();
  if (liveTokensOf(userId).length >= MAX_PER_USER) return { error: 'limit' };

  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  const record = {
    id: crypto.randomUUID(),
    userId,
    zoomUserId,
    name: (name || '').trim() || 'API token',
    scopes: [...new Set(scopes)],
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
    lastUsedAt: null,
  };
  byHash.set(hashOf(token), record);
  return { token, ...describe(record) };
}

/** Look a presented token up. Returns its record (and marks it used), or null. */
function authenticate(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 200) return null;
  // Lookup by hash: the comparison never touches the secret itself
  const record = byHash.get(hashOf(token));
  if (!record) return null;
  if (!isLive(record)) {
    byHash.delete(hashOf(token));
    return null;
  }
  record.lastUsedAt = Date.now();
  return record;
}

function list(userId) {
  return liveTokensOf(userId).sort((a, b) => a.createdAt - b.createdAt).map(describe);
}

/** Revoke one of the user's tokens. Returns whether it existed. */
function revoke(userId, id) {
  for (const [hash, record] of byHash) {
    if (record.id === id && record.userId === userId) {
      byHash.delete(hash);
      return true;
    }
  }
  return false;
}

/** Revoke everything a user holds (logout, app removal). Returns how many. */
function revokeAllFor(userId) {
  let count = 0;
  for (const [hash, record] of byHash) {
    if (record.userId === userId) {
      byHash.delete(hash);
      count += 1;
    }
  }
  return count;
}

module.exports = {
  SCOPES,
  MAX_PER_USER,
  validate,
  create,
  authenticate,
  list,
  revoke,
  revokeAllFor,
  _resetForTests: () => byHash.clear(),
  _dumpForTests: () => [...byHash.entries()],
  _expireForTests: (id) => {
    for (const record of byHash.values()) if (record.id === id) record.expiresAt = Date.now() - 1;
  },
};
