/**
 * A timeline of RTMS events per user, for testing RTMS workflows.
 *
 * Records what was asked of Zoom through Arlo's REST proxy, which webhooks
 * Zoom sent, and what Arlo's own stream connection did, so a script can see
 * the whole sequence for a meeting (for example: REST start → host denied →
 * started → joined → stopped) and compare it with a start made in the client.
 *
 * Kept in memory only, 200 entries per user for 12 hours. It holds event
 * names, status codes, meeting UUIDs and times: no transcript, no names, no
 * tokens, no server URLs.
 *
 * Attribution: an event belongs to the Zoom user who started the stream
 * (`operator_id` on Zoom's webhooks). Later events for the same meeting that
 * carry no operator (stopped, interrupted, Arlo's own) follow that meeting.
 * Events for a meeting nobody here started are not recorded.
 */
const MAX_PER_USER = 200;
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MEETINGS = 5000;

// Zoom's rtms.request_status codes
const REQUEST_STATUS_MEANING = {
  1: 'The request is denied.',
  2: 'The app owner is not present in the meeting.',
  3: 'The host denied this app from starting.',
  4: 'The app account license has expired or the feature is disabled.',
  5: 'No RTMS concurrency limit is set.',
  6: 'The RTMS server failed. Submit a request for a new stream.',
  7: 'The RTMS server instance is being updated and will reboot.',
  8: 'The RTMS server instance updates have been canceled.',
};

const byUser = new Map(); // zoomUserId -> [entry]
const meetingOwner = new Map(); // meetingUuid -> { zoomUserId, at }
let lastAt = 0;

/** Strictly increasing timestamps, so "since" never misses or repeats an entry. */
function nextTime() {
  lastAt = Math.max(Date.now(), lastAt + 1);
  return lastAt;
}

function ownerOf(meetingUuid) {
  const owner = meetingOwner.get(meetingUuid);
  if (!owner) return null;
  if (Date.now() - owner.at > TTL_MS) {
    meetingOwner.delete(meetingUuid);
    return null;
  }
  return owner.zoomUserId;
}

function claim(meetingUuid, zoomUserId) {
  if (!meetingOwner.has(meetingUuid) && meetingOwner.size >= MAX_MEETINGS) {
    meetingOwner.delete(meetingOwner.keys().next().value);
  }
  meetingOwner.set(meetingUuid, { zoomUserId, at: Date.now() });
}

/**
 * Record an event. `zoomUserId` attributes it directly (and claims the
 * meeting); without it the meeting's known owner is used. Returns whether it
 * was recorded.
 */
function record({ event, zoomUserId = null, meetingUuid = null, detail = {} }) {
  const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const meeting = isId(meetingUuid) ? meetingUuid : null;
  let owner = isId(zoomUserId) ? zoomUserId : null;
  if (owner && meeting) claim(meeting, owner);
  if (!owner && meeting) owner = ownerOf(meeting);
  if (!owner) return false;

  const entries = byUser.get(owner) || [];
  entries.push({ at: nextTime(), event, meetingUuid: meeting, detail });
  if (entries.length > MAX_PER_USER) entries.splice(0, entries.length - MAX_PER_USER);
  byUser.set(owner, entries);
  return true;
}

/** A user's entries, oldest first, optionally only those after `since` (ms). */
function list(zoomUserId, { since = 0 } = {}) {
  const cutoff = Date.now() - TTL_MS;
  const entries = (byUser.get(zoomUserId) || []).filter((e) => e.at > cutoff);
  if (entries.length === 0) byUser.delete(zoomUserId);
  else byUser.set(zoomUserId, entries);
  return entries
    .filter((e) => e.at > since)
    .map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
}

/** Turn one of Zoom's RTMS webhooks into a timeline entry. */
function recordWebhook(event, payload) {
  const meetingUuid = payload?.meeting_uuid ?? payload?.id_field?.meeting_uuid ?? null;
  const detail = {};
  if (event === 'rtms.request_status' && Number.isInteger(payload?.status)) {
    detail.status = payload.status;
    detail.meaning = REQUEST_STATUS_MEANING[payload.status] || 'Unknown status';
  }
  if (Number.isInteger(payload?.stop_reason)) detail.stopReason = payload.stop_reason;
  return record({ event, zoomUserId: payload?.operator_id, meetingUuid, detail });
}

function forgetUser(zoomUserId) {
  byUser.delete(zoomUserId);
  for (const [meeting, owner] of meetingOwner) {
    if (owner.zoomUserId === zoomUserId) meetingOwner.delete(meeting);
  }
}

module.exports = {
  record,
  recordWebhook,
  list,
  forgetUser,
  _resetForTests: () => { byUser.clear(); meetingOwner.clear(); },
};
