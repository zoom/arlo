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

/**
 * An approval as the server sends it (`arlo.approval`, GET …/arlo/approvals),
 * rebuilt from known fields: { id, kind, askedBy, expiresAt }. null when it is not one.
 */
export function parseApproval(data) {
  if (data === null || typeof data !== 'object') return null;
  const { id, kind, expiresAt } = data;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) return null;
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_KIND_CHARS) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { id, kind, askedBy: usableName(data.askedBy), expiresAt };
}

/** The texts and action of a kind, or null for one this panel does not know. */
export const approvalKind = (kind) => (
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_KINDS, kind) ? APPROVAL_KINDS[kind] : null
);

/** The oldest approval this panel can show, or null. */
export const firstShowableApproval = (approvals) => (
  (Array.isArray(approvals) ? approvals : []).find((approval) => approvalKind(approval?.kind) !== null) ?? null
);
