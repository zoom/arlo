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
 *   doneToast, failedToast, unsentToast   what the owner is told after agreeing (null: nothing)
 *
 * 'agent_action' is something Arlo was asked to do ("Arlo, let James in") by
 * someone whose request needs an owner's approval. Its texts are the server's:
 *
 *   question       a short template it fills with checked arguments (required)
 *   primaryLabel   the primary button's text ("Do it" when it gives none)
 *   body           the exact text that will be posted to the chat, when it posts
 *   request        what was asked, for context
 *   askedBy        who asked; for a spoken request the speaker's Zoom display
 *                  name, which anyone can set. `askerVerified` is true only
 *                  when the server knows who asked; `channel` says how.
 *
 * The owner approves exactly what they see, so none of these is ever cut or
 * changed: one whose question is missing, or where any of these texts is not
 * text or is longer than its limit, is not an approval. It is not shown and
 * not answered. When the owner agrees the server runs it and says how it
 * ended (`arlo.did`), so no toast says "done" here.
 *
 *   failedToast    the server took the answer and could not do it
 *   unsentToast    the answer did not reach the server
 */
export const AGENT_ACTION = 'agent_action';
/** The longest texts of an 'agent_action' this panel shows (the server's own limits). */
export const AGENT_LIMITS = Object.freeze({
  question: 200, primaryLabel: 40, body: 500, request: 200, askedBy: 60,
});
const CHANNELS = new Set(['voice', 'panel']);
const AGENT_TEXTS = Object.freeze({
  primary: 'Do it',
  secondary: 'Not now',
  doneToast: null,
  failedToast: 'Arlo couldn\'t do that.',
  unsentToast: 'Arlo didn\'t get your answer. Try again.',
});

/**
 * Who asked, as far as the server knows. A name the server did not verify is
 * shown as what it is: what Zoom displayed for the speaker.
 */
function agentDetail({ askedBy, askerVerified, channel }) {
  if (askerVerified === true && askedBy) return `${askedBy} asked Arlo to do this.`;
  if (channel === 'panel') return 'Someone in the meeting asked.';
  return askedBy
    ? `Someone shown as \u201c${askedBy}\u201d asked by voice. Arlo can't confirm who spoke.`
    : 'Someone in the meeting asked by voice.';
}

/**
 * The server's texts of an 'agent_action', whole: { question, primaryLabel,
 * body, request, askedBy, askerVerified, channel } with null for a text it did
 * not give. null when it is not one this panel may show: no question, or a
 * text that is not text, is blank where it must say something (question,
 * body), or is longer than its limit. Nothing is cut.
 */
function agentFields(data) {
  const fields = {};
  for (const [name, max] of Object.entries(AGENT_LIMITS)) {
    const value = data[name];
    if (value === undefined || value === null) {
      fields[name] = null;
    } else if (typeof value !== 'string' || value.length > max) {
      return null;
    } else {
      fields[name] = value;
    }
  }
  if (fields.question === null || fields.question.trim().length === 0) return null;
  if (fields.body !== null && fields.body.trim().length === 0) return null;
  // Blank is "not given" for the texts the sheet can do without
  if (fields.primaryLabel !== null && fields.primaryLabel.trim().length === 0) fields.primaryLabel = null;
  if (fields.request !== null && fields.request.trim().length === 0) fields.request = null;
  return {
    ...fields,
    askerVerified: data.askerVerified === true,
    channel: CHANNELS.has(data.channel) ? data.channel : null,
  };
}

export const APPROVAL_KINDS = Object.freeze({
  share_notes: Object.freeze({
    question: 'Share the notes with everyone in the meeting?',
    detail: (askedBy) => (askedBy ? `${askedBy} asked to see them.` : 'Someone in the meeting asked to see them.'),
    primary: 'Share notes',
    secondary: 'Not now',
    doneToast: 'Notes are now shared with everyone',
    failedToast: 'Couldn\'t share the notes. Try again.',
    unsentToast: 'Couldn\'t share the notes. Try again.',
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
 * rebuilt from known fields: { id, kind, askedBy, expiresAt, expiresInMs } and,
 * for an 'agent_action', its texts whole ({ question, primaryLabel, body,
 * request, askerVerified, channel }; null for the other kinds).
 * `expiresAt` is by the server's clock; `expiresInMs` is the time left as the
 * server gave it, or null (it does not today). null when it is not one, and
 * for an 'agent_action' this panel may not show (see above).
 */
export function parseApproval(data) {
  if (data === null || typeof data !== 'object') return null;
  const { id, kind, expiresAt, expiresInMs } = data;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) return null;
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_KIND_CHARS) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const agent = kind === AGENT_ACTION ? agentFields(data) : null;
  if (kind === AGENT_ACTION && agent === null) return null;
  const timeLeft = typeof expiresInMs === 'number' && Number.isFinite(expiresInMs)
    ? Math.min(Math.max(0, expiresInMs), MAX_TIME_LEFT_MS)
    : null;
  return {
    id,
    kind,
    // A name that would show as a blank is no name
    askedBy: usableName(agent ? agent.askedBy : data.askedBy),
    expiresAt,
    expiresInMs: timeLeft,
    question: agent?.question ?? null,
    primaryLabel: agent?.primaryLabel ?? null,
    body: agent?.body ?? null,
    request: agent?.request ?? null,
    askerVerified: agent?.askerVerified === true,
    channel: agent?.channel ?? null,
  };
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

/**
 * The sheet's texts for one approval: { question, detail, primary, secondary,
 * doneToast, failedToast, unsentToast, body, request } (`body` and `request`
 * null unless an 'agent_action' has them), or null for one this panel cannot
 * show: a kind it does not know, or an 'agent_action' it may not show.
 */
export function approvalTexts(approval) {
  if (approval === null || typeof approval !== 'object') return null;
  if (approval.kind === AGENT_ACTION) {
    const agent = agentFields(approval);
    if (agent === null) return null;
    return {
      ...AGENT_TEXTS,
      question: agent.question,
      body: agent.body,
      request: agent.request,
      detail: agentDetail({ ...agent, askedBy: usableName(agent.askedBy) }),
      primary: agent.primaryLabel ?? AGENT_TEXTS.primary,
    };
  }
  const kind = approvalKind(approval.kind);
  return kind ? { ...kind, body: null, request: null, detail: kind.detail(approval.askedBy) } : null;
}

/** The oldest approval this panel can show, or null. */
export const firstShowableApproval = (approvals) => (
  (Array.isArray(approvals) ? approvals : []).find((approval) => approvalTexts(approval) !== null) ?? null
);
