import { usableName } from './ownerName';

/**
 * What the owner is asked for each kind of approval. Agreeing only reports the
 * answer: the server does the work (for 'share_notes' it shares the notes with
 * everyone in the meeting who has Arlo open). A kind that is not here is not
 * shown and not answered: it is left to run out on the server. Add a kind by
 * adding an entry.
 *
 *   question, primary, secondary   the sheet's texts
 *   detail(askedBy)                who asked; `askedBy` is a usable name or null
 *   doneToast, failedToast         what the owner is told after agreeing
 */
export const APPROVAL_KINDS = Object.freeze({
  share_notes: Object.freeze({
    question: 'Share the notes with everyone in the meeting?',
    detail: (askedBy) => (askedBy ? `${askedBy} asked to see them.` : 'Someone in the meeting asked to see them.'),
    primary: 'Share notes',
    secondary: 'Not now',
    doneToast: 'Notes are now shared with everyone',
    failedToast: 'Couldn\'t share the notes. Try again.',
  }),
});

const MAX_ID_CHARS = 64;
const MAX_KIND_CHARS = 64;

/** How long the server waits for an owner's answer (its default; it does not say). */
export const APPROVAL_WINDOW_MS = 60 * 1000;
// The longest time left this panel takes from a server
const MAX_TIME_LEFT_MS = 10 * 60 * 1000;
// A response's `Date` header is in whole seconds
const SERVER_CLOCK_SLACK_MS = 1000;

/**
 * An approval as the server sends it (`arlo.approval`, GET …/arlo/approvals),
 * rebuilt from known fields: { id, kind, askedBy, expiresAt, expiresInMs }.
 * `expiresAt` is by the server's clock; `expiresInMs` is the time left as the
 * server gave it, or null (it does not today). null when it is not one.
 */
export function parseApproval(data) {
  if (data === null || typeof data !== 'object') return null;
  const { id, kind, expiresAt, expiresInMs } = data;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) return null;
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_KIND_CHARS) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const timeLeft = typeof expiresInMs === 'number' && Number.isFinite(expiresInMs)
    ? Math.min(Math.max(0, expiresInMs), MAX_TIME_LEFT_MS)
    : null;
  return { id, kind, askedBy: usableName(data.askedBy), expiresAt, expiresInMs: timeLeft };
}

/**
 * How long an approval still waits, in ms from the moment it was received.
 * The server's `expiresAt` is by the server's clock and this panel's clock
 * may be minutes off, so the two are never simply compared:
 *
 * 1. the time left as the server gives it (`expiresInMs`), when it does;
 * 2. `expiresAt` against the server's own clock (`serverNow`: the `Date`
 *    header of the response it came in), when that is known and plausible;
 * 3. over the socket (`fetched` false) it was just opened: the whole window;
 * 4. read from the server without its clock: `expiresAt` against this panel's
 *    clock when that gives something a server would say (not past by more
 *    than the window, not further ahead than it), else the whole window.
 *
 * The server closes an approval at its own time whatever is shown here, and
 * says so; answering one it closed is refused.
 */
export function approvalTimeLeft(approval, { now, fetched = false, serverNow = null }) {
  if (approval.expiresInMs !== null && approval.expiresInMs !== undefined) return approval.expiresInMs;
  if (typeof serverNow === 'number' && Number.isFinite(serverNow)) {
    const left = approval.expiresAt - serverNow;
    if (left <= APPROVAL_WINDOW_MS + SERVER_CLOCK_SLACK_MS && left > -APPROVAL_WINDOW_MS) return left;
  }
  if (!fetched) return APPROVAL_WINDOW_MS;
  const left = approval.expiresAt - now;
  return Math.abs(left) <= APPROVAL_WINDOW_MS ? left : APPROVAL_WINDOW_MS;
}

/** The texts and action of a kind, or null for one this panel does not know. */
export const approvalKind = (kind) => (
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_KINDS, kind) ? APPROVAL_KINDS[kind] : null
);

/** The oldest approval this panel can show, or null. */
export const firstShowableApproval = (approvals) => (
  (Array.isArray(approvals) ? approvals : []).find((approval) => approvalKind(approval?.kind) !== null) ?? null
);
