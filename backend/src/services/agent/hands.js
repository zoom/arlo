/**
 * The hands: what Arlo can only do through the Zoom Apps SDK (post to the
 * meeting chat, admit someone from the waiting room) is sent to one owner's
 * open panel as an action; the panel runs it and reports the result.
 *
 * A panel says what it can do after it subscribes, over its socket:
 *   { type: 'arlo.hands', payload: { zoomRole, can: [tool names] } }
 * (readHandsAnnouncement below; services/websocket.js keeps it on the socket).
 * An announcement is a claim, so it only counts for a socket whose user is an
 * owner of the meeting at the moment an action is sent, not when it was made.
 *
 * run(meetingId, { tool, args }) picks one panel:
 *   - its user is an owner of the meeting now, and it listed the tool;
 *   - for `admit_from_waiting_room` its Zoom role is host or co-host;
 *   - a host's or co-host's panel first, then the one connected longest.
 * It sends { type: 'arlo.action', data: { meetingId, actionId, tool, args } }
 * and waits for result(), which the route POST …/arlo/actions/:actionId/result
 * calls for the signed-in user who reports. Resolves to
 *   { ok: true }
 *   { ok: false, code }  a code the panel reported (RESULT_CODES), or
 *                        'no_hands' (no suitable panel), 'timeout' (no result
 *                        in `timeoutMs`), 'busy' (too many wait already),
 *                        'unsupported' (not a panel's tool), 'gone' (the
 *                        meeting's data was flushed meanwhile).
 * It never rejects.
 *
 * A result counts once, and only from the user the action was sent to, for
 * the meeting it was sent in, while that user is still an owner.
 *
 * `args` were checked against the tool table by the caller. Nothing here is
 * logged: an action's arguments are what someone asked for.
 *
 * Kept per meeting: the actions waiting for a result (at most
 * `maxPendingPerMeeting`), gone with the meeting (forget()).
 */
const crypto = require('node:crypto');
const { PANEL_TOOL_NAMES } = require('./tools');

const MAX_ID_CHARS = 256;
const MAX_ROLE_CHARS = 32;
const MAX_ANNOUNCED_TOOLS = 10;
// Zoom roles an announcement may carry; any other is an attendee's
const ZOOM_ROLES = new Set(['host', 'coHost', 'attendee', 'panelist']);
// Who may let people in from the waiting room
const MAY_ADMIT = new Set(['host', 'coHost']);
// What a panel may report when it did not do it
const RESULT_CODES = Object.freeze(['not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed']);
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
  schedule = defaultSchedule,
  timeoutMs = 15000,
  maxPendingPerMeeting = 10,
} = {}) {
  // actionId -> { meetingId, userId, settle(result) }
  const pending = new Map();

  const owns = (meetingId, userId) => {
    try {
      return isId(userId) && isOwner(meetingId, userId) === true;
    } catch {
      return false;
    }
  };

  /** The panels that may run this tool now, the preferred one first. */
  function candidates(meetingId, tool) {
    let list = [];
    try {
      list = panels(meetingId);
    } catch {
      return [];
    }
    return (Array.isArray(list) ? list : [])
      .filter((panel) => isPlainObject(panel) && typeof panel.send === 'function'
        && Array.isArray(panel.can) && panel.can.includes(tool)
        && (tool !== 'admit_from_waiting_room' || MAY_ADMIT.has(panel.zoomRole))
        && owns(meetingId, panel.userId))
      .sort((a, b) => (MAY_ADMIT.has(b.zoomRole) - MAY_ADMIT.has(a.zoomRole)) || (a.since - b.since));
  }

  const waitingIn = (meetingId) => [...pending.values()].filter((one) => one.meetingId === meetingId).length;

  function run(meetingId, call) {
    if (!isPlainObject(call) || typeof call.tool !== 'string' || !PANEL_TOOL_NAMES.includes(call.tool) || !isPlainObject(call.args)) {
      return Promise.resolve(fail('unsupported'));
    }
    if (!isId(meetingId)) return Promise.resolve(fail('no_hands'));
    const { tool, args } = call;
    const able = candidates(meetingId, tool);
    if (able.length === 0) return Promise.resolve(fail('no_hands'));
    if (waitingIn(meetingId) >= maxPendingPerMeeting) return Promise.resolve(fail('busy'));

    return new Promise((resolve) => {
      const actionId = crypto.randomUUID();
      const entry = { meetingId, userId: null, settle: null };
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
        // Whose result counts is set before the send: the panel may answer at once
        entry.userId = panel.userId;
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

  /**
   * A panel's report: { ok: true } or { ok: false, code? }. Returns whether it
   * was taken: false for an action that is unknown or finished, was sent in
   * another meeting or to someone else, for someone who is no longer an owner,
   * and for anything that is not a report.
   */
  function result(meetingId, actionId, userId, report) {
    if (!isId(meetingId) || typeof actionId !== 'string' || !UUID.test(actionId) || !isId(userId)) return false;
    if (!isPlainObject(report) || typeof report.ok !== 'boolean') return false;
    const entry = pending.get(actionId);
    if (!entry || entry.meetingId !== meetingId || entry.userId !== userId || !owns(meetingId, userId)) return false;
    if (report.ok) {
      entry.settle({ ok: true });
    } else {
      entry.settle(fail(typeof report.code === 'string' && RESULT_CODES.includes(report.code) ? report.code : 'sdk_error'));
    }
    return true;
  }

  /** The meeting's data is gone: what waited for a panel ends, and a late result is refused. */
  function forget(meetingId) {
    for (const entry of [...pending.values()]) {
      if (entry.meetingId === meetingId) entry.settle(fail('gone'));
    }
  }

  return {
    run, result, forget, pending: () => pending.size,
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
