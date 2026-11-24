/**
 * Who brought Arlo into a meeting, and what one panel is told about Arlo there.
 *
 * An "owner" is an Arlo user who ran a stream of their own in the meeting. The
 * notes are theirs to see, and theirs to share with everyone in the meeting
 * who has Arlo open (`notesShared`, off until an owner turns it on); everyone
 * else gets the participant view. Owners are
 * not stored here: they are worked out each time from the meeting's streams
 * (services/meetingStreams.js keeps each stream's operator, a Zoom user id)
 * looked up among the users who signed in to Arlo. An operator who never
 * signed in to Arlo is nobody's owner. Someone stays an owner after their
 * stream stops, so their notes survive a stop and restart, until the meeting's
 * data is deleted: from then on the meeting has no owner.
 *
 * The owner's name the panels show is the account's own display name. An
 * account can have none (sign-in without the Zoom scope that gives names):
 * then it is the name that owner's own panel supplied for this meeting (their
 * Zoom screen name), and null when there is neither. Never a blank.
 *
 * What is kept per meeting, who may ask Arlo, whether the notes are shared and
 * those supplied names, lives
 * in the meeting store with the transcript and is deleted with it. Nothing
 * here is logged.
 */
const { cleanName } = require('../lib/displayName');

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
    // A name of spaces only is no name
    return { id: user.id, name: cleanName(user.displayName) || null };
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
    // The account's own name, otherwise the one their panel supplied
    const supplied = store.getMeta(meetingId).ownerNames;
    return [...found.values()].map((owner) => ({
      id: owner.id,
      name: owner.name ?? (cleanName(supplied.get(owner.id)) || null),
      hasAccountName: owner.name !== null,
    }));
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
    const owner = isUserId(userId) && list.some((one) => one.id === userId);
    const meta = store.getMeta(meetingId);
    // operators() lists the primary stream's operator first, so the first owner
    // is that person when they are an Arlo user, and the next owner otherwise
    return {
      present: status !== null,
      // The meeting as a whole: every running stream is paused
      paused: status === 'rtms_paused',
      // Their own stream, for an owner only. It can be paused while the
      // meeting is not: someone else's stream still runs
      ...(owner && {
        myStreamPaused: isTheirs(streams.pauseState(meetingId).operators, userId),
        // Whether a stream of their own runs right now. Someone stays an owner
        // after their stream stops, also while another person's still runs
        myStreamLive: isTheirs(streams.liveOperators(meetingId), userId),
      }),
      role: owner ? 'owner' : 'participant',
      ownerName: list.length > 0 ? list[0].name : null,
      whoCanAsk: meta.whoCanAsk,
      // Whether the owners share the notes with everyone in the meeting
      notesShared: meta.notesShared === true,
    };
  }

  /** Whether one of these Zoom user ids is this Arlo user's. */
  const isTheirs = (zoomUserIds, userId) => zoomUserIds.some((zoomUserId) => arloUser(zoomUserId)?.id === userId);

  /**
   * The Zoom user id under which this Arlo user runs a stream of their own in
   * the meeting right now, or null. Pause and resume are theirs to report only
   * then: the Apps SDK's pause acts on the caller's own stream.
   */
  function liveStreamOperator(meetingId, userId) {
    if (!isUserId(userId) || !store.has(meetingId)) return null;
    return streams.liveOperators(meetingId).find((zoomUserId) => arloUser(zoomUserId)?.id === userId) ?? null;
  }

  /** Change who may ask Arlo. Any owner may; false for anyone else or a bad value. */
  function setWhoCanAsk(meetingId, userId, value) {
    if (typeof value !== 'string' || !WHO_CAN_ASK.has(value)) return false;
    if (!isOwner(meetingId, userId)) return false;
    return store.setMeta(meetingId, { whoCanAsk: value }) !== null;
  }

  /** Whether the meeting's notes are shared with everyone in it. False once its data is gone. */
  const notesShared = (meetingId) => store.getMeta(meetingId).notesShared === true;

  /**
   * Share the notes with everyone in the meeting, or stop. Any owner may.
   * 'refused' for anyone else or for a value that is not true or false;
   * 'unchanged' when it was so already; 'changed' otherwise.
   */
  function setNotesShared(meetingId, userId, value) {
    if (typeof value !== 'boolean' || !isOwner(meetingId, userId)) return 'refused';
    if (notesShared(meetingId) === value) return 'unchanged';
    return store.setMeta(meetingId, { notesShared: value }) !== null ? 'changed' : 'refused';
  }

  /**
   * Keep the display name an owner's panel supplied for this meeting. The
   * caller validates what a name may be; here it must be a non-blank string.
   * 'refused' for anyone who is not an owner of this meeting or for something
   * that is not a name; 'unchanged' when nothing was kept (the account has a
   * name of its own, which wins, or this name is held already, or the
   * meeting holds as many as it takes); 'stored' when it is the owner's name now.
   */
  function setDisplayName(meetingId, userId, value) {
    const name = cleanName(value);
    if (name.length === 0 || !isUserId(userId)) return 'refused';
    const owner = owners(meetingId).find((one) => one.id === userId);
    if (!owner) return 'refused';
    if (owner.hasAccountName || owner.name === name) return 'unchanged';
    const meta = store.setMeta(meetingId, { ownerNameFor: { userId, name } });
    if (meta === null) return 'refused';
    return meta.ownerNames.get(userId) === name ? 'stored' : 'unchanged';
  }

  return {
    stateFor, setWhoCanAsk, setDisplayName, setNotesShared, notesShared, isOwner, ownerUserIds, liveStreamOperator,
  };
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
