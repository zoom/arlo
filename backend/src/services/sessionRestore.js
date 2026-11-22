/**
 * Session restore: survive a backend restart without a database.
 *
 * Users and OAuth tokens live in memory, so a restart (or a nodemon reload in
 * development) used to sign everyone out. At sign-in the server now also sets
 * an httpOnly cookie holding the user's record and Zoom refresh token,
 * encrypted with TOKEN_ENCRYPTION_KEY (AES-GCM, authenticated). When a request
 * arrives with a valid session token but the user is gone from memory, the
 * server rebuilds the record from that cookie. Nothing is written to disk.
 *
 * Three token kinds exist and must never stand in for each other:
 *   sessionToken   signed JWT, proves who the caller is
 *   meetingAccess  signed JWT, proves the caller is in one meeting
 *   sessionRestore this encrypted blob; useless without a matching sessionToken
 */
const config = require('../config');
const { encryptToken, decryptToken } = require('./auth');
const { userStore, tokenStore } = require('../lib/memoryStore');

const RESTORE_COOKIE = 'sessionRestore';
const RESTORE_TYPE = 'arlo-session-restore';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // same lifetime as the session token
const MAX_COOKIE_CHARS = 3800; // browsers cap a cookie at about 4096 bytes

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'lax',
});

const isString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Encrypt what is needed to rebuild a session. Returns the cookie value. */
function sealSession({ user, refreshToken, scopes }) {
  const base = {
    typ: RESTORE_TYPE,
    v: 1,
    iat: Date.now(),
    uid: user.id,
    zid: user.zoomUserId,
    name: user.displayName || '',
    email: user.email || '',
    avatar: user.avatarUrl || null,
    scopes: Array.isArray(scopes) ? scopes.slice(0, 50) : [],
  };
  const sealed = encryptToken(JSON.stringify({ ...base, rt: refreshToken || null }));
  // An oversized cookie would be dropped by the browser. Identity alone still
  // keeps the user signed in; they re-authorize when a Zoom API call is needed.
  return sealed.length <= MAX_COOKIE_CHARS ? sealed : encryptToken(JSON.stringify({ ...base, rt: null }));
}

/** Decrypt and validate a restore cookie. Returns the payload or null. */
function openSession(cookieValue) {
  if (!isString(cookieValue, MAX_COOKIE_CHARS + 200)) return null;
  try {
    const payload = JSON.parse(decryptToken(cookieValue));
    if (payload?.typ !== RESTORE_TYPE || payload.v !== 1) return null;
    if (typeof payload.iat !== 'number' || Date.now() - payload.iat > MAX_AGE_MS) return null;
    if (!isString(payload.uid, 100) || !isString(payload.zid, 200)) return null;
    return payload;
  } catch {
    return null; // wrong key, tampered, or not ours
  }
}

/** Set the restore cookie on a response (sign-in, and when the refresh token rotates). */
function setRestoreCookie(res, { user, refreshToken, scopes }) {
  res.cookie(RESTORE_COOKIE, sealSession({ user, refreshToken, scopes }), {
    ...cookieOptions(),
    maxAge: MAX_AGE_MS,
  });
}

function clearRestoreCookie(res) {
  res.clearCookie(RESTORE_COOKIE, cookieOptions());
}

/**
 * Rebuild the in-memory user for an already verified session, if they are
 * missing and the request carries their restore cookie. Returns true when a
 * user was restored. `session` is the verified session token payload.
 */
function restoreIfMissing(req, session) {
  if (userStore.findById(session.userId)) return false;
  const payload = openSession(req.cookies?.[RESTORE_COOKIE]);
  // The cookie must belong to the user the session token names.
  if (!payload || payload.uid !== session.userId || payload.zid !== session.zoomUserId) return false;

  userStore.restore({
    id: payload.uid,
    zoomUserId: payload.zid,
    email: typeof payload.email === 'string' ? payload.email.slice(0, 320) : '',
    displayName: typeof payload.name === 'string' ? payload.name.slice(0, 200) : '',
    avatarUrl: typeof payload.avatar === 'string' ? payload.avatar.slice(0, 2000) : null,
  });
  if (isString(payload.rt, 4000)) {
    tokenStore.store(payload.uid, {
      accessToken: null,
      refreshToken: encryptToken(payload.rt),
      expiresAt: new Date(0), // no access token: it must be refreshed before use
      scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((s) => typeof s === 'string') : [],
    });
  }
  console.log('Session restored from cookie after a server restart');
  return true;
}

module.exports = {
  RESTORE_COOKIE,
  sealSession,
  openSession,
  setRestoreCookie,
  clearRestoreCookie,
  restoreIfMissing,
};
