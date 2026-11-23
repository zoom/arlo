/**
 * OAuth state that needs no server memory.
 *
 * A sign-in spans two requests (start, then Zoom's redirect back), sometimes a
 * minute apart. Keeping the state and PKCE verifier in a Map meant any server
 * restart in between ended the sign-in with "Invalid OAuth state". Here the
 * state validates itself and the verifier is derived from it:
 *
 *   state    = kind . nonce . expiry . HMAC(key, "kind.nonce.expiry")
 *   verifier = HMAC(key, "verifier:" + state)
 *
 * kind is 'w' (browser sign-in) or 'i' (in-client sign-in from the Zoom SDK),
 * so one flow's state cannot be used in the other. The key is derived from
 * SESSION_SECRET, which is stable across restarts.
 *
 * Two things are still kept in memory, and losing them on a restart is safe:
 *  - which states were already used (single use; Zoom's authorization code is
 *    itself single use, so a replay after a restart gains nothing)
 *  - codes waiting to be picked up by the panel during an in-client sign-in
 */
const crypto = require('crypto');
const config = require('../config');

const TTL_MS = 5 * 60 * 1000;
const MAX_STATE_CHARS = 120;
const KINDS = { web: 'w', inclient: 'i' };
const KIND_NAMES = { w: 'web', i: 'inclient' };

const key = crypto.createHmac('sha256', config.sessionSecret).update('arlo-oauth-state-v1').digest();
const sign = (text) => crypto.createHmac('sha256', key).update(text).digest('base64url');

const usedStates = new Map(); // state -> expiry (ms)
const pendingCodes = new Map(); // state -> { code, expiresAt }

function prune(map, expiryOf) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (expiryOf(v) <= now) map.delete(k);
  }
}

/** Create a state for a new sign-in. Returns { state, codeVerifier }. */
function issue(kind, { now = Date.now() } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown OAuth flow: ${kind}`);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const expiry = Math.floor((now + TTL_MS) / 1000).toString(36);
  const body = `${k}.${nonce}.${expiry}`;
  const state = `${body}.${sign(body).slice(0, 22)}`;
  return { state, codeVerifier: sign(`verifier:${state}`) };
}

/** Check a state. Returns { kind, codeVerifier, expiresAt } or null. */
function verify(state) {
  if (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE_CHARS) return null;
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [k, nonce, expiry, signature] = parts;
  if (!KIND_NAMES[k]) return null;

  const expected = Buffer.from(sign(`${k}.${nonce}.${expiry}`).slice(0, 22));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const expiresAt = parseInt(expiry, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  return { kind: KIND_NAMES[k], codeVerifier: sign(`verifier:${state}`), expiresAt };
}

/** Verify a state and mark it used. Returns what verify() returns, or null if invalid or already used. */
function consume(state, expectedKind) {
  const verified = verify(state);
  if (!verified || (expectedKind && verified.kind !== expectedKind)) return null;
  prune(usedStates, (expiresAt) => expiresAt);
  if (usedStates.has(state)) return null;
  usedStates.set(state, verified.expiresAt);
  return verified;
}

/** In-client sign-in, browser leg: keep the code until the panel asks for it. */
function holdCode(state, code) {
  prune(pendingCodes, (entry) => entry.expiresAt);
  pendingCodes.set(state, { code, expiresAt: Date.now() + TTL_MS });
}

function heldCode(state) {
  const entry = pendingCodes.get(state);
  return entry && entry.expiresAt > Date.now() ? entry.code : null;
}

function releaseCode(state) {
  pendingCodes.delete(state);
}

module.exports = {
  issue,
  verify,
  consume,
  holdCode,
  heldCode,
  releaseCode,
  _resetForTests: () => { usedStates.clear(); pendingCodes.clear(); },
};
