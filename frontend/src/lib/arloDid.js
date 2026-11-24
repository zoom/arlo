import { usableName } from './ownerName';

/**
 * What Arlo was asked and did in a meeting, as the server tells it
 * (GET …/arlo/actions, `arlo.did`): { id, at, tool, label, askedBy, channel,
 * status, public }. The label is the server's own sentence; it and the name
 * of who asked are shown as text only.
 */
const STATUSES = new Set(['pending', 'waiting_approval', 'done', 'declined', 'failed', 'expired']);
/** How an action can end. One that ended does not change again. */
export const ENDED = new Set(['done', 'declined', 'failed', 'expired']);
const CHANNELS = new Set(['voice', 'panel']);
const MAX_ID_CHARS = 64;
const MAX_TOOL_CHARS = 64;
const MAX_LABEL_CHARS = 300;
/** How many actions a panel holds for a meeting; the oldest go first. */
export const MAX_ACTIONS = 500;

/** How an action that was not done ended, in words. */
const ENDED_WORDS = Object.freeze({
  declined: 'declined',
  expired: 'no answer',
  failed: 'couldn\'t do it',
});

/** An action rebuilt from known fields; null when it is not one. */
export function parseAction(data) {
  if (data === null || typeof data !== 'object') return null;
  const { id, at, tool, status } = data;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > MAX_TOOL_CHARS) return null;
  if (!STATUSES.has(status)) return null;
  const label = typeof data.label === 'string' ? data.label.trim().slice(0, MAX_LABEL_CHARS) : '';
  if (label === '') return null;
  return {
    id,
    at,
    tool,
    label,
    askedBy: usableName(data.askedBy),
    channel: CHANNELS.has(data.channel) ? data.channel : null,
    status,
    public: data.public === true,
  };
}

/**
 * `held` with `incoming` put in: one entry per id, the newest word winning,
 * except that an action that ended is not taken back by an earlier word that
 * arrives late. Oldest first by `at`; at most MAX_ACTIONS, the oldest dropped.
 * Returns `held` itself when nothing changed.
 */
export function mergeActions(held, incoming) {
  let next = held;
  incoming.forEach((action) => {
    const at = next.findIndex((one) => one.id === action.id);
    if (at === -1) {
      next = [...next, action];
      return;
    }
    const before = next[at];
    if (ENDED.has(before.status) && !ENDED.has(action.status)) return;
    if (before.status === action.status && before.label === action.label && before.askedBy === action.askedBy
        && before.at === action.at && before.public === action.public) return;
    next = [...next];
    next[at] = action;
  });
  if (next === held) return held;
  const sorted = next.map((action, index) => ({ action, index }))
    .sort((a, b) => (a.action.at - b.action.at) || (a.index - b.index))
    .map((entry) => entry.action);
  return sorted.length > MAX_ACTIONS ? sorted.slice(sorted.length - MAX_ACTIONS) : sorted;
}

/** "<label> · <askedBy> asked", or the label alone when nobody is named. */
export const actionLine = (action) => (action.askedBy ? `${action.label} · ${action.askedBy} asked` : action.label);

/** The line for the meeting record: how it ended is said when it was not done. */
export function recordLine(action) {
  const words = ENDED_WORDS[action.status];
  return words ? `${actionLine(action)} · ${words}` : actionLine(action);
}

/** What the notes list: the actions that were done, oldest first. */
export const doneActions = (actions) => (Array.isArray(actions) ? actions : []).filter((action) => action?.status === 'done');

/** What the meeting record lists: the actions that ended, however they did. */
export const endedActions = (actions) => (Array.isArray(actions) ? actions : []).filter((action) => ENDED.has(action?.status));
