/**
 * The hands: what Arlo can only do through the Zoom Apps SDK (post to the
 * meeting chat, admit someone from the waiting room, invite everyone to open
 * the app, send a reaction, mute someone, open a ticket in the browser and
 * bring up the share dialog) is sent to an owner's open panel as an action;
 * the panel runs it and reports the result.
 *
 * WHOSE PANEL. An action runs only on a panel of the owner who typed the
 * request or who pressed the approval: run() is given that user, and no other
 * owner's panel is ever used, host or not. An owner must not find that their
 * client posted or admitted something they never saw.
 *
 * A panel says what it can do after it subscribes, over its socket:
 *   { type: 'arlo.hands', payload: { zoomRole, can: [tool names] } }
 * (readHandsAnnouncement below; services/websocket.js keeps it on the socket).
 * An announcement is a claim, so it only counts for a socket whose user is an
 * owner of the meeting at the moment an action is sent, not when it was made.
 *
 * run(meetingId, { tool, args, userId }) picks one panel:
 *   - its user is `userId`, who is an owner of the meeting now, and it listed
 *     the tool;
 *   - for a tool that needs a host (`admit_from_waiting_room`,
 *     `mute_participant`: `needsHost` in the tool table) its Zoom role is
 *     host or co-host;
 *   - of several, the one connected longest.
 * It sends { type: 'arlo.action', data: { meetingId, actionId, tool, args } }
 * and waits for result(), which the route POST …/arlo/actions/:actionId/result
 * calls for the signed-in user who reports. Resolves to
 *   { ok: true }
 *   { ok: false, code }  a code the panel reported (RESULT_CODES), or
 *                        'no_hands' (that owner has no suitable panel, or no
 *                        owner was given), 'timeout' (no result in
 *                        `timeoutMs`), 'busy' (too many wait already),
 *                        'unsupported' (not a panel's tool), 'gone' (the
 *                        meeting's data was flushed meanwhile).
 * It always settles, and never rejects.
 *
 * whoCan(meetingId, tool) is the owners who have such a panel open now: the
 * agent asks before it puts a sheet on anyone's panel for a tool that needs a
 * host.
 *
 * A result counts once, and only from the user the action was sent to, for
 * the meeting it was sent in, while that user is still an owner. The same
 * user may send the same result again for `resultRepeatMs` (two minutes): a
 * panel whose first POST got no response retries, and is answered as the
 * first time. Another user, or another verdict, is refused as before.
 *
 * `args` were checked against the tool table by the caller. Nothing here is
 * logged: an action's arguments are what someone asked for.
 *
 * Kept per meeting: the actions waiting for a result (at most
 * `maxPendingPerMeeting`), and for two minutes who reported what (at most
 * `maxReported` in all, the oldest dropped first). Gone with the meeting
 * (forget()).
 */
const crypto = require('node:crypto');
const { PANEL_TOOL_NAMES, HOST_TOOL_NAMES } = require('./tools');

const MAX_ID_CHARS = 256;
const MAX_ROLE_CHARS = 32;
const MAX_ANNOUNCED_TOOLS = 10;
// Zoom roles an announcement may carry; any other is an attendee's
const ZOOM_ROLES = new Set(['host', 'coHost', 'attendee', 'panelist']);
// Who may let people in from the waiting room, and mute someone
const MAY_ADMIT = new Set(['host', 'coHost']);
// What a panel may report when it did not do it
// 'share_failed': a ticket was opened and the share dialog was not (open_ticket)
const RESULT_CODES = Object.freeze(['not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed', 'share_failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => ({ ok: false, code });

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

/**
 * What a panel announced, rebuilt: { zoomRole, can }, or null when it is not
 * an announcement: not exactly those two fields, a role that is not a short
 * string, or a list with more than ten entries or with anything that is not a
 * panel tool's name. Refused as a whole, never cleaned up.
 */
function readHandsAnnouncement(payload) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('zoomRole') || !keys.includes('can')) return null;
  const { zoomRole, can } = payload;
  if (typeof zoomRole !== 'string' || zoomRole.length > MAX_ROLE_CHARS) return null;
  if (!Array.isArray(can) || can.length > MAX_ANNOUNCED_TOOLS) return null;
  if (!can.every((name) => typeof name === 'string' && PANEL_TOOL_NAMES.includes(name))) return null;
  return { zoomRole: ZOOM_ROLES.has(zoomRole) ? zoomRole : 'attendee', can: [...new Set(can)] };
}

function createHands({
  // (meetingId) -> the open sockets verified for that meeting that announced
  // hands: [{ userId, zoomRole, can, since, send(message) -> boolean }]
  panels,
  // (meetingId, userId) -> whether this Arlo user is an owner of the meeting now
  isOwner,
  now = Date.now,
  schedule = defaultSchedule,
  timeoutMs = 15000,
  maxPendingPerMeeting = 10,
  resultRepeatMs = 2 * 60 * 1000,
  maxReported = 500,
} = {}) {
  // actionId -> { meetingId, userId, settle(result) }
  const pending = new Map();
  // actionId -> { meetingId, userId, verdict, at }: results taken, oldest first, for a retry
  const reported = new Map();

  const owns = (meetingId, userId) => {
    try {
      return isId(userId) && isOwner(meetingId, userId) === true;
    } catch {
      return false;
    }
  };

  /** This owner's panels that may run this tool now, the one connected longest first. */
  function candidates(meetingId, tool, userId) {
    let list = [];
    try {
      list = panels(meetingId);
    } catch {
      return [];
    }
    return (Array.isArray(list) ? list : [])
      .filter((panel) => isPlainObject(panel) && typeof panel.send === 'function'
        && (userId === undefined || panel.userId === userId)
        && Array.isArray(panel.can) && panel.can.includes(tool)
        && (!HOST_TOOL_NAMES.includes(tool) || MAY_ADMIT.has(panel.zoomRole))
        && owns(meetingId, panel.userId))
      .sort((a, b) => a.since - b.since);
  }

  /** The owners who have a panel open now that may run this tool. No one for anything that is not a panel's tool. */
  function whoCan(meetingId, tool) {
    if (!isId(meetingId) || typeof tool !== 'string' || !PANEL_TOOL_NAMES.includes(tool)) return [];
    return [...new Set(candidates(meetingId, tool).map((panel) => panel.userId))];
  }

  const waitingIn = (meetingId) => [...pending.values()].filter((one) => one.meetingId === meetingId).length;

  function run(meetingId, call) {
    if (!isPlainObject(call) || typeof call.tool !== 'string' || !PANEL_TOOL_NAMES.includes(call.tool) || !isPlainObject(call.args)) {
      return Promise.resolve(fail('unsupported'));
    }
    // Without the owner who typed or approved it there is nobody's panel to use
    if (!isId(meetingId) || !isId(call.userId)) return Promise.resolve(fail('no_hands'));
    const { tool, args, userId } = call;
    const able = candidates(meetingId, tool, userId);
    if (able.length === 0) return Promise.resolve(fail('no_hands'));
    if (waitingIn(meetingId) >= maxPendingPerMeeting) return Promise.resolve(fail('busy'));

    return new Promise((resolve) => {
      const actionId = crypto.randomUUID();
      const entry = { meetingId, userId, settle: null };
      const cancel = schedule(() => entry.settle(fail('timeout')), timeoutMs);
      entry.settle = (result) => {
        if (pending.get(actionId) !== entry) return;
        pending.delete(actionId);
        cancel();
        resolve(result);
      };
      pending.set(actionId, entry);

      const message = {
        type: 'arlo.action',
        data: {
          meetingId, actionId, tool, args,
        },
      };
      for (const panel of able) {
        let sent = false;
        try {
          sent = panel.send(message) === true;
        } catch {
          sent = false;
        }
        if (sent) return;
      }
      entry.settle(fail('no_hands'));
    });
  }

  /** Keep who reported what for a while, so the same report sent again is answered the same. */
  function remember(actionId, meetingId, userId, verdict) {
    const at = now();
    for (const [id, one] of reported) {
      if (at - one.at < resultRepeatMs && reported.size < maxReported) break;
      reported.delete(id);
    }
    reported.set(actionId, {
      meetingId, userId, verdict, at,
    });
  }

  /**
   * A panel's report: { ok: true } or { ok: false, code? }. Returns whether it
   * was taken: false for an action that is unknown or finished, was sent in
   * another meeting or to someone else, for someone who is no longer an owner,
   * and for anything that is not a report. The same report again from the
   * same user, within `resultRepeatMs` of the first, is taken again (and
   * changes nothing): the panel retried a POST whose response it never got.
   */
  function result(meetingId, actionId, userId, report) {
    if (!isId(meetingId) || typeof actionId !== 'string' || !UUID.test(actionId) || !isId(userId)) return false;
    if (!isPlainObject(report) || typeof report.ok !== 'boolean') return false;
    if (!owns(meetingId, userId)) return false;
    const verdict = report.ok
      ? 'ok'
      : (typeof report.code === 'string' && RESULT_CODES.includes(report.code) ? report.code : 'sdk_error');
    const entry = pending.get(actionId);
    if (!entry) {
      const before = reported.get(actionId);
      return before !== undefined && before.meetingId === meetingId && before.userId === userId
        && before.verdict === verdict && now() - before.at < resultRepeatMs;
    }
    if (entry.meetingId !== meetingId || entry.userId !== userId) return false;
    remember(actionId, meetingId, userId, verdict);
    entry.settle(report.ok ? { ok: true } : fail(verdict));
    return true;
  }

  /** The meeting's data is gone: what waited for a panel ends, and a late or repeated result is refused. */
  function forget(meetingId) {
    for (const entry of [...pending.values()]) {
      if (entry.meetingId === meetingId) entry.settle(fail('gone'));
    }
    for (const [actionId, one] of reported) {
      if (one.meetingId === meetingId) reported.delete(actionId);
    }
  }

  return {
    run, result, whoCan, forget, pending: () => pending.size, remembered: () => reported.size,
  };
}

let instance = null;

/** The hands the running server uses: the panels are the sockets, the owners the presence service's. */
function getHands() {
  if (!instance) {
    // Required here, not at the top: websocket.js and the lifecycle require each other's neighbours
    /* eslint-disable global-require */
    const { handsPanels } = require('../websocket');
    const { getArloPresence } = require('../arloPresence');
    /* eslint-enable global-require */
    instance = createHands({
      panels: handsPanels,
      isOwner: (meetingId, userId) => getArloPresence().isOwner(meetingId, userId),
    });
  }
  return instance;
}

module.exports = {
  createHands, getHands, readHandsAnnouncement, RESULT_CODES,
};
