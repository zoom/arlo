/**
 * Users who removed the app (Zoom `app_deauthorized`).
 *
 * Deleting the user's record is not enough: their session token stays valid
 * until it expires, and their restore cookie could rebuild the record. This
 * remembers who deauthorized for as long as either could still be alive, so
 * both are refused until the user authorizes the app again.
 *
 * In memory only, like everything else in demo mode. After a server restart a
 * cookie issued before the deauthorization could restore the user's own
 * profile from their own browser; Zoom has revoked the tokens by then.
 */
const HOLD_MS = 25 * 60 * 60 * 1000; // a little longer than a session (24h)
const MAX_ENTRIES = 50000;

const deauthorizedAt = new Map(); // zoomUserId -> time

function mark(zoomUserId) {
  if (deauthorizedAt.size >= MAX_ENTRIES) {
    deauthorizedAt.delete(deauthorizedAt.keys().next().value); // oldest first
  }
  deauthorizedAt.delete(zoomUserId);
  deauthorizedAt.set(zoomUserId, Date.now());
}

function isDeauthorized(zoomUserId) {
  const at = deauthorizedAt.get(zoomUserId);
  if (at === undefined) return false;
  if (Date.now() - at > HOLD_MS) {
    deauthorizedAt.delete(zoomUserId);
    return false;
  }
  return true;
}

/** The user authorized the app again. */
function clear(zoomUserId) {
  deauthorizedAt.delete(zoomUserId);
}

module.exports = { mark, isDeauthorized, clear, _resetForTests: () => deauthorizedAt.clear() };
