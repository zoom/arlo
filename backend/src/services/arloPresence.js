/**
 * Who brought Arlo into a meeting, and what one panel is told about Arlo there.
 *
 * An "owner" is an Arlo user who ran a stream of their own in the meeting. The
 * notes are theirs to see; everyone else gets the participant view. Owners are
 * not stored here: they are worked out each time from the meeting's streams
 * (services/meetingStreams.js keeps each stream's operator, a Zoom user id)
 * looked up among the users who signed in to Arlo. An operator who never
 * signed in to Arlo is nobody's owner. Someone stays an owner after their
 * stream stops, so their notes survive a stop and restart, until the meeting's
 * data is deleted: from then on the meeting has no owner.
 *
 * The one setting per meeting, who may ask Arlo, lives in the meeting store
 * with the transcript and is deleted with it. Nothing here is logged.
 */
const MAX_NAME_CHARS = 200;
const WHO_CAN_ASK = new Set(['owner', 'anyone']);

const isUserId = (value) => typeof value === 'string' && value.length > 0;

function createArloPresence({ store, streams, findUserByZoomId, streamStatus }) {
  /** The Arlo user behind a Zoom user id, or null. A lookup that fails finds nobody. */
  function arloUser(zoomUserId) {
    let user = null;
    try {
      user = findUserByZoomId(zoomUserId);
    } catch {
      return null;
    }
    if (user === null || typeof user !== 'object' || !isUserId(user.id)) return null;
    const name = typeof user.displayName === 'string' && user.displayName.length > 0
      ? user.displayName.slice(0, MAX_NAME_CHARS)
      : null;
    return { id: user.id, name };
  }

  /**
   * The meeting's owners, the operator of the primary stream first. Empty once
   * the meeting's data is gone, whatever is still known about its streams.
   */
  function owners(meetingId) {
    if (!store.has(meetingId)) return [];
    const found = new Map(); // Arlo user id -> owner, each once
    for (const zoomUserId of streams.operators(meetingId)) {
      const user = arloUser(zoomUserId);
      if (user && !found.has(user.id)) found.set(user.id, user);
    }
    return [...found.values()];
  }

  const ownerUserIds = (meetingId) => owners(meetingId).map((owner) => owner.id);

  const isOwner = (meetingId, userId) => isUserId(userId) && ownerUserIds(meetingId).includes(userId);

  /**
   * What a panel is told. `userId` is the Arlo user on that socket, or null for
   * someone not signed in. The owner's name is only for sockets already
   * verified to be in this meeting.
   */
  function stateFor(meetingId, userId) {
    const status = streamStatus(meetingId) || null;
    const list = owners(meetingId);
    // operators() lists the primary stream's operator first, so the first owner
    // is that person when they are an Arlo user, and the next owner otherwise
    return {
      present: status !== null,
      paused: status === 'rtms_paused',
      role: isUserId(userId) && list.some((owner) => owner.id === userId) ? 'owner' : 'participant',
      ownerName: list.length > 0 ? list[0].name : null,
      whoCanAsk: store.getMeta(meetingId).whoCanAsk,
    };
  }

  /** Change who may ask Arlo. Any owner may; false for anyone else or a bad value. */
  function setWhoCanAsk(meetingId, userId, value) {
    if (typeof value !== 'string' || !WHO_CAN_ASK.has(value)) return false;
    if (!isOwner(meetingId, userId)) return false;
    return store.setMeta(meetingId, { whoCanAsk: value }) !== null;
  }

  return { stateFor, setWhoCanAsk, isOwner, ownerUserIds };
}

let instance = null;

/** The one the running server uses. */
function getArloPresence() {
  if (!instance) {
    // Required here, not at the top: websocket.js requires this module
    /* eslint-disable global-require */
    const { getMeetingStore } = require('../storage');
    const { getMeetingStreams } = require('./meetingStreams');
    const { userStore } = require('../lib/memoryStore');
    const { currentStreamStatus } = require('./websocket');
    /* eslint-enable global-require */
    instance = createArloPresence({
      store: getMeetingStore(),
      streams: getMeetingStreams(),
      findUserByZoomId: (zoomUserId) => userStore.findByZoomId(zoomUserId),
      streamStatus: currentStreamStatus,
    });
  }
  return instance;
}

module.exports = { createArloPresence, getArloPresence };
