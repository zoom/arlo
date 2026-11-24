/**
 * Zoom App Context verification and meeting-scoped access tokens.
 *
 * The Zoom client hands the app an encrypted "app context" (zoomSdk.getAppContext(),
 * also sent as the X-Zoom-App-Context header on Home URL loads). Only Zoom and
 * this app (via the client secret) can produce or read it, so a valid context
 * proves the caller has the app open inside meeting `mid`. That works for guests
 * too, which lets us grant transcript access without a Zoom OAuth sign-in.
 *
 * Format (https://developers.zoom.us/docs/zoom-apps/zoom-app-context/):
 *   base64url( [ivLength:1][iv][aadLength:2 LE][aad][cipherTextLength:4 LE][cipherText][tag:16] )
 *   AES-256-GCM, key = SHA-256(client secret). Payload: { typ, uid, mid, pid?, ts, exp, ... }
 */
const crypto = require('crypto');
const config = require('../config');
const { generateToken, verifyToken } = require('./auth');

const MAX_CONTEXT_CHARS = 8192;
const ACCESS_TOKEN_KIND = 'meeting-access';
const ACCESS_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4h; the frontend refreshes on every WS (re)connect
// The context types a meeting-access token is issued for. Zoom's app context
// page lists `typ` as 'panel', 'meeting', 'webinar' or 'chat', and `mid` as
// "only returned when value of typ is 'meeting'".
//
// NOT SETTLED, Collaborate mode: the Collaborate guide says "When participants
// join Collaborate mode, the Collaborate UUID is included in the context
// header" and "The app can use app context header to get the verified meeting
// id or collaboration id", but no page names the `typ` of a context made while
// the app runs in Collaborate, the field that holds the Collaborate UUID, or
// whether `mid` is still there. So nothing is accepted here that was not
// before: a Collaborate context is taken only when it reads as a meeting's
// (`typ` 'meeting' or 'webinar', with a `mid`). If Zoom gives it another
// `typ`, or leaves `mid` out, POST /api/auth/meeting-access answers 403 in
// Collaborate and the panel shows its access notice. Check it in a real
// meeting before adding a value here, and add exactly that value, still
// requiring `mid`.
const MEETING_TYPES = new Set(['meeting', 'webinar']);

class AppContextError extends Error {}

/** Normalise a Zoom timestamp to milliseconds (accepts seconds or milliseconds). */
function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Decrypt an app context token. Throws AppContextError on any malformed input. */
function decryptAppContext(context, clientSecret = config.zoomClientSecret) {
  if (typeof context !== 'string' || context.length === 0 || context.length > MAX_CONTEXT_CHARS) {
    throw new AppContextError('Invalid app context');
  }
  const buf = Buffer.from(context, 'base64'); // Node's base64 decoder also accepts base64url
  let offset = 0;
  const need = (n) => {
    if (offset + n > buf.length) throw new AppContextError('Truncated app context');
  };

  need(1);
  const ivLength = buf.readUInt8(offset); offset += 1;
  if (ivLength === 0) throw new AppContextError('Invalid IV length');
  need(ivLength);
  const iv = buf.subarray(offset, offset + ivLength); offset += ivLength;

  need(2);
  const aadLength = buf.readUInt16LE(offset); offset += 2;
  need(aadLength);
  const aad = buf.subarray(offset, offset + aadLength); offset += aadLength;

  need(4);
  const cipherLength = buf.readUInt32LE(offset); offset += 4;
  need(cipherLength + 16);
  const cipherText = buf.subarray(offset, offset + cipherLength); offset += cipherLength;
  const tag = buf.subarray(offset, offset + 16);

  const key = crypto.createHash('sha256').update(clientSecret).digest();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aadLength > 0) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new AppContextError('App context failed authentication');
  }
}

/**
 * Decrypt and validate a context for in-meeting use.
 * Returns { meetingId, parentMeetingId, zoomUserId, expiresAt }.
 */
function verifyMeetingAppContext(context, { now = Date.now(), clientSecret } = {}) {
  const payload = decryptAppContext(context, clientSecret);

  const expiresAt = toMs(payload.exp);
  if (!expiresAt || now >= expiresAt) {
    throw new AppContextError('App context expired');
  }
  if (!MEETING_TYPES.has(payload.typ)) {
    throw new AppContextError('App context is not for a meeting');
  }
  if (typeof payload.mid !== 'string' || payload.mid.length === 0 || payload.mid.length > 200) {
    throw new AppContextError('App context has no meeting ID');
  }

  return {
    meetingId: payload.mid,
    parentMeetingId: typeof payload.pid === 'string' ? payload.pid : null, // set in breakout rooms
    zoomUserId: typeof payload.uid === 'string' ? payload.uid : null,
    expiresAt,
  };
}

/** Issue a signed token that grants live-transcript access to exactly one meeting. */
function issueMeetingAccessToken({ meetingId, zoomUserId, userId }, now = Date.now()) {
  return generateToken({
    kind: ACCESS_TOKEN_KIND,
    meetingId,
    zoomUserId: zoomUserId || null,
    userId: userId || null,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_MS,
  });
}

/** Verify a meeting access token. Throws if invalid, expired, or not an access token. */
function verifyMeetingAccessToken(token) {
  const payload = verifyToken(token);
  if (payload.kind !== ACCESS_TOKEN_KIND || typeof payload.meetingId !== 'string' || !payload.exp) {
    throw new Error('Invalid meeting access token');
  }
  return payload;
}

module.exports = {
  AppContextError,
  decryptAppContext,
  verifyMeetingAppContext,
  issueMeetingAccessToken,
  verifyMeetingAccessToken,
  ACCESS_TOKEN_TTL_MS,
};
