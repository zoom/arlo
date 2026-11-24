/**
 * Arlo's routes for one meeting, mounted at
 * /api/meetings/by-zoom-id/:zoomMeetingId/arlo
 *
 *   GET  /state     what this panel is told: is Arlo here, and what is this person to it
 *   PUT  /settings  { whoCanAsk?: 'owner' | 'anyone', displayName?: string, shareNotes?: boolean }, owners only
 *   GET  /notes     the live notes: owners, and everyone in the meeting while the notes are shared
 *   POST /ask       { question }: an answer from the stored transcript, private to the asker
 *   POST /notes-request          {}: a participant asks the owners to share the notes with everyone
 *   POST /approvals/:approvalId  { approve }: an owner's answer, owners only; approving turns sharing on
 *   GET  /approvals              the open requests, owners only
 *   POST /identity               { participantUUID?, participantId?, screenName? }: who Zoom tells an
 *                                owner's panel they are in the meeting, owners only (a measurement)
 *   GET  /identity-check         how often a transcript line's speaker equalled one: counters, owners only
 *
 * SECURITY
 * - Every route needs the meeting-access cookie for exactly this meeting
 *   (requireMeetingAccess): the same proof that opens the WebSocket. Being
 *   signed in does not replace it.
 * - "Owner" is decided on the server (services/arloPresence.js), never taken
 *   from the request.
 * - Request bodies are JSON objects with exactly the known fields. Anything
 *   else is refused, not cleaned up. In particular /ask takes no transcript
 *   and no model from the client: the transcript is the one the server stored.
 * - Nothing is cached, and nothing about a question or an answer is stored or
 *   logged. Log lines carry an error code at most.
 */
const express = require('express');
const config = require('../config');
const { requireAuth, optionalAuth, requireMeetingAccess } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/aiLimiter');
const { getMeetingStore } = require('../storage');
const { getArloPresence } = require('../services/arloPresence');
const { getApprovals, approvalMessageData } = require('../services/approvals');
const { broadcastArloState, sendApprovalOpened, sendNotesUpdated } = require('../services/websocket');
const { getNotesEngine } = require('../services/notesEngine');
const { userStore } = require('../lib/memoryStore');
const { newestLines } = require('../lib/transcriptLines');
const { showableName, cleanName } = require('../lib/displayName');
// Through the module object, so tests can replace the model call
const openrouter = require('../services/openrouter');

const router = express.Router({ mergeParams: true });

const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const MAX_QUESTION_CHARS = 500;
const MAX_DISPLAY_NAME_CHARS = 100;
const SETTINGS_FIELDS = ['whoCanAsk', 'displayName', 'shareNotes'];
const IDENTITY_FIELDS = ['participantUUID', 'participantId', 'screenName'];
const MAX_IDENTITY_CHARS = 200;
// C0 and C1 control characters and DEL
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_ANSWER_CHARS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RATE_LIMITED_MESSAGE = 'The free AI models are rate limited right now. Try again in a minute.';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A JSON object whose keys are exactly `keys`. */
const hasExactly = (body, keys) => isPlainObject(body)
  && Object.keys(body).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(body, key));
/** A JSON object with at least one of `keys` and nothing else. */
const hasOnlySomeOf = (body, keys) => isPlainObject(body)
  && Object.keys(body).length > 0
  && Object.keys(body).every((key) => keys.includes(key));

/**
 * The display name a panel supplies, NFC-normalized and trimmed, or null when
 * it is not one: a string of 1 to 100 characters after that, with a letter or
 * a digit in it, and without control, invisible, private-use or unassigned
 * characters (see lib/displayName.js: a name made of those shows as a blank,
 * and a direction override turns the sentence around it).
 */
function readDisplayName(value) {
  if (typeof value !== 'string' || value.length > MAX_DISPLAY_NAME_CHARS * 4) return null;
  const name = showableName(value);
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_CHARS) return null;
  return name;
}

// Meeting content, and who is what in a meeting, must not outlive the meeting
// in a browser or proxy cache. First, so refusals are not cached either.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** Bodies are JSON only: a form post (which a page on another site can send) is refused. */
function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Unsupported Media Type', message: 'Send JSON' });
  }
  return next();
}

const forbidden = (res, message) => res.status(403).json({ error: 'Forbidden', message });
const invalid = (res, message) => res.status(400).json({ error: 'Invalid request', message });

const NOT_AN_OWNER = 'Only the person who brought Arlo in can change this.';

/**
 * Share the meeting's notes with everyone in it who has Arlo open, or stop:
 * the one way it happens, for the setting and for an approved request alike.
 * 'refused' when this person is not an owner of the meeting (or its data is
 * gone), 'unchanged' when it was so already, 'changed' otherwise.
 *
 * On a change every panel is told the new state first, so a panel knows the
 * notes are shared before any arrive, and that they are not the moment
 * sharing stops (from then on sendNotesUpdated() reaches owners only). Turned
 * on, the notes so far go to everyone who may now see them, the requests for
 * them that were still open are answered, and the notes engine looks again:
 * a participant's panel may be the reader it was waiting for.
 */
function shareNotes(meetingId, userId, value) {
  const presence = getArloPresence();
  const outcome = presence.setNotesShared(meetingId, userId, value);
  if (outcome !== 'changed') return outcome;
  // That it happened: never who did it
  console.log(`Arlo setting changed: notes sharing ${value ? 'on' : 'off'}`);
  broadcastArloState(meetingId);
  if (!value) return outcome;
  const notes = getMeetingStore().getNotes(meetingId);
  if (notes) sendNotesUpdated(meetingId, presence.ownerUserIds(meetingId), notes);
  const approvals = getApprovals();
  for (const approval of approvals.listOpen(meetingId)) {
    if (approval.kind === 'share_notes') approvals.answer(meetingId, approval.id, { byUserId: userId, approve: true, done: true });
  }
  getNotesEngine().ownerPanelConnected(meetingId);
  return outcome;
}

/**
 * GET /state
 * { present, paused, role: 'owner' | 'participant', ownerName, whoCanAsk, notesShared }
 * Open to guests in the meeting: a guest is a participant.
 */
router.get('/state', optionalAuth, requireMeetingAccess, (req, res) => {
  res.json(getArloPresence().stateFor(req.params.zoomMeetingId, req.user?.id ?? null));
});

/**
 * PUT /settings
 * { whoCanAsk?, displayName?, shareNotes? }: at least one, nothing else.
 * `whoCanAsk` changes who may ask Arlo. `shareNotes` (true or false) shares the
 * live notes with everyone in the meeting who has Arlo open, or stops; see
 * shareNotes() above. `displayName` is the caller's own name
 * for this meeting (their panel sends their Zoom screen name): it is shown as
 * the owner's name only when their account has no name, and is deleted with
 * the meeting. Answers the caller's new state; every panel of the meeting is
 * told over its socket when something changed. A name is never logged.
 */
router.put('/settings', requireAuth, requireMeetingAccess, requireJson, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const presence = getArloPresence();
  if (!presence.isOwner(meetingId, req.user.id)) {
    return forbidden(res, 'Only the person who brought Arlo in can change this.');
  }
  // Everything is validated before anything is changed
  if (!hasOnlySomeOf(req.body, SETTINGS_FIELDS)) {
    return invalid(res, 'Send whoCanAsk, displayName, shareNotes, or several of them, and nothing else');
  }
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
  const whoCanAsk = hasOwn('whoCanAsk') ? req.body.whoCanAsk : undefined;
  if (whoCanAsk !== undefined && (typeof whoCanAsk !== 'string' || !WHO_CAN_ASK.has(whoCanAsk))) {
    return invalid(res, 'whoCanAsk must be "owner" or "anyone"');
  }
  const displayName = hasOwn('displayName') ? readDisplayName(req.body.displayName) : undefined;
  if (displayName === null) {
    return invalid(res, `displayName must be 1 to ${MAX_DISPLAY_NAME_CHARS} characters with a letter or digit, without control or invisible characters`);
  }
  const sharing = hasOwn('shareNotes') ? req.body.shareNotes : undefined;
  if (sharing !== undefined && typeof sharing !== 'boolean') {
    return invalid(res, 'shareNotes must be true or false');
  }

  let changed = false;
  if (whoCanAsk !== undefined) {
    if (!presence.setWhoCanAsk(meetingId, req.user.id, whoCanAsk)) {
      // The meeting's data went between the two checks
      return forbidden(res, 'Only the person who brought Arlo in can change this.');
    }
    console.log('Arlo setting changed: who can ask');
    changed = true;
  }
  if (displayName !== undefined) {
    const outcome = presence.setDisplayName(meetingId, req.user.id, displayName);
    if (outcome === 'refused') {
      return forbidden(res, 'Only the person who brought Arlo in can change this.');
    }
    if (outcome === 'stored') {
      // That it happened, never the name
      console.log('Arlo setting changed: an owner\'s panel supplied their display name');
      changed = true;
    }
  }
  if (changed) broadcastArloState(meetingId);
  // Last, and it tells the panels itself: the state they get has the other changes too
  if (sharing !== undefined && shareNotes(meetingId, req.user.id, sharing) === 'refused') {
    return forbidden(res, NOT_AN_OWNER);
  }
  return res.json(presence.stateFor(meetingId, req.user.id));
});

/**
 * GET /notes
 * { notes: { summary, decisions, actionItems, updatedAt, throughSeqNo } | null }
 * For an owner always. For everyone else in the meeting (the meeting-access
 * cookie is the proof, so a guest too) only while an owner shares the notes;
 * 403 otherwise. Decided on each request: nothing is handed out after sharing
 * stopped.
 */
router.get('/notes', optionalAuth, requireMeetingAccess, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const presence = getArloPresence();
  const mayRead = presence.isOwner(meetingId, req.user?.id ?? null) || presence.notesShared(meetingId);
  if (!mayRead) {
    return forbidden(res, 'The notes are for the person who brought Arlo in, until they share them.');
  }
  return res.json({ notes: getMeetingStore().getNotes(meetingId) });
});

/**
 * POST /ask
 * { question } -> { answer }. For an owner, and for other signed-in people in
 * the meeting only when the meeting's setting is "anyone". The answer goes to
 * the asker alone.
 */
router.post('/ask', requireAuth, requireMeetingAccess, aiLimiter, requireJson, async (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const store = getMeetingStore();
  const mayAsk = getArloPresence().isOwner(meetingId, req.user.id)
    || store.getMeta(meetingId).whoCanAsk === 'anyone';
  if (!mayAsk) {
    return forbidden(res, 'Only the person who brought Arlo in can ask Arlo in this meeting.');
  }
  if (!hasExactly(req.body, ['question']) || typeof req.body.question !== 'string') {
    return invalid(res, 'question is required');
  }
  const question = req.body.question.trim();
  if (question.length === 0 || req.body.question.length > MAX_QUESTION_CHARS) {
    return invalid(res, `question must be 1 to ${MAX_QUESTION_CHARS} characters`);
  }
  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }
  const { lines } = newestLines(store.listSegments(meetingId), MAX_TRANSCRIPT_CHARS);
  if (lines.length === 0) {
    return res.status(409).json({ error: 'no_transcript', message: 'Nothing has been said since Arlo joined.' });
  }

  try {
    const answer = await openrouter.answerFromTranscript({ question, lines, model: config.notesModel });
    // The model's answer is untrusted: text only, and bounded
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw Object.assign(new Error('empty answer'), { code: 'empty_response' });
    }
    // Flushed while the model was answering: the answer is about a transcript
    // that is deleted, and what is deleted is not handed out afterwards
    if (!store.has(meetingId)) {
      return res.status(409).json({ error: 'no_transcript', message: 'The meeting has ended.' });
    }
    return res.json({ answer: answer.trim().slice(0, MAX_ANSWER_CHARS) });
  } catch (error) {
    // The code only: an error message can quote the model or the transcript
    console.error(`Arlo ask failed (${error && typeof error.code === 'string' ? error.code : 'error'})`);
    if (error && error.code === 'rate_limited') return res.status(429).json({ error: RATE_LIMITED_MESSAGE });
    return res.status(502).json({ error: 'The AI service could not answer right now.' });
  }
});

/**
 * The account's own display name, as the presence service reads it for an
 * owner: null when the account has none. Never logged.
 */
function accountName(userId) {
  let user = null;
  try {
    user = userStore.findById(userId);
  } catch {
    return null;
  }
  return cleanName(user?.displayName) || null;
}

/**
 * POST /notes-request
 * {} -> { id, expiresAt }. A signed-in participant asks the people who brought
 * Arlo in to share the notes with everyone in the meeting. Their panels are
 * asked (`arlo.approval`); when one agrees the server turns sharing on, and
 * the notes then reach the asker like everyone else. 409 `already_shared`
 * when they are shared already.
 */
router.post('/notes-request', requireAuth, requireMeetingAccess, requireJson, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  if (!hasExactly(req.body, [])) return invalid(res, 'Send an empty JSON object');
  const presence = getArloPresence();
  const owners = presence.ownerUserIds(meetingId);
  if (owners.includes(req.user.id)) return invalid(res, 'You have the notes already.');
  if (owners.length === 0) {
    return res.status(409).json({ error: 'no_owner', message: 'Nobody brought Arlo into this meeting.' });
  }
  if (presence.notesShared(meetingId)) {
    return res.status(409).json({ error: 'already_shared', message: 'The notes are shared with everyone already.' });
  }
  if (presence.stateFor(meetingId, req.user.id).present !== true) {
    return res.status(409).json({ error: 'arlo_absent', message: 'Arlo is not in the meeting right now.' });
  }
  const opened = getApprovals().open(meetingId, {
    kind: 'share_notes', askedByUserId: req.user.id, askedByName: accountName(req.user.id),
  });
  if (!opened) {
    return res.status(429).json({ error: 'too_soon', message: 'You asked a moment ago. Try again in a couple of minutes.' });
  }
  // That it happened: never who asked
  console.log('Arlo approval opened (share_notes)');
  const approval = getApprovals().get(meetingId, opened.id);
  if (approval) sendApprovalOpened(meetingId, owners, approvalMessageData(meetingId, approval));
  return res.json({ id: opened.id, expiresAt: opened.expiresAt });
});

/**
 * POST /approvals/:approvalId
 * { approve: false } declined | { approve: true } approved: the server turns
 * sharing the notes on, as PUT /settings { shareNotes: true } does
 * -> { id, outcome }. A boolean `done` is still accepted and ignored (panels
 * that posted the notes to the chat sent it). The first answer wins; 404 for
 * an id nothing is open under. The owners and the person who asked are told
 * over their sockets (services/approvals.js).
 */
router.post('/approvals/:approvalId', requireAuth, requireMeetingAccess, requireJson, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const owners = getArloPresence().ownerUserIds(meetingId);
  const notFound = () => res.status(404).json({ error: 'not_found', message: 'That request is no longer open.' });
  // A meeting nobody owns (its data is deleted) has nothing left to answer
  if (owners.length === 0) return notFound();
  if (!owners.includes(req.user.id)) {
    return forbidden(res, 'Only the person who brought Arlo in can answer this.');
  }
  const id = req.params.approvalId;
  if (typeof id !== 'string' || !UUID.test(id)) return invalid(res, 'Not an approval id');
  const body = req.body;
  const shape = hasExactly(body, ['approve']) || hasExactly(body, ['approve', 'done']);
  if (!shape || typeof body.approve !== 'boolean') return invalid(res, 'Send { approve: boolean } and nothing else');
  const hasDone = Object.prototype.hasOwnProperty.call(body, 'done');
  if (hasDone && typeof body.done !== 'boolean') return invalid(res, 'done must be true or false');

  const approvals = getApprovals();
  // Looked up before anything is changed: an answer to nothing shares nothing
  if (approvals.get(meetingId, id) === null) return notFound();
  if (!body.approve) {
    const declined = approvals.answer(meetingId, id, { byUserId: req.user.id, approve: false });
    return declined === null ? notFound() : res.json({ id, outcome: declined });
  }
  // The work is done here, not in the panel. Turning sharing on answers the
  // open requests itself; one is still open only when the notes were shared
  // already, or when they could not be (then it closes as 'failed')
  const shared = shareNotes(meetingId, req.user.id, true) !== 'refused';
  if (approvals.get(meetingId, id) !== null) {
    approvals.answer(meetingId, id, { byUserId: req.user.id, approve: true, done: shared });
  }
  return res.json({ id, outcome: shared ? 'approved' : 'failed' });
});

/**
 * GET /approvals
 * { approvals: [{ meetingId, id, kind, askedBy, expiresAt }] }, oldest first:
 * what an owner's panel that reloads still has to answer.
 */
router.get('/approvals', requireAuth, requireMeetingAccess, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  if (!getArloPresence().isOwner(meetingId, req.user.id)) {
    return forbidden(res, 'Only the person who brought Arlo in sees these.');
  }
  return res.json({
    approvals: getApprovals().listOpen(meetingId).map((approval) => approvalMessageData(meetingId, approval)),
  });
});

/**
 * POST /identity
 * { participantUUID?, participantId?, screenName? } -> { stored: true }. At
 * least one, nothing else; each a string of 1 to 200 characters without
 * control characters. What Zoom's Apps SDK tells an owner's panel about its
 * own user in this meeting. Kept with the meeting's data (one per owner) and
 * deleted with it; compared with the speaker of each transcript line stored
 * from then on, and only the counts are kept. Never logged, never returned.
 */
router.post('/identity', requireAuth, requireMeetingAccess, requireJson, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const presence = getArloPresence();
  if (!presence.isOwner(meetingId, req.user.id)) return forbidden(res, NOT_AN_OWNER);
  const problem = `Send participantUUID, participantId, screenName, or several of them, each 1 to ${MAX_IDENTITY_CHARS} characters without control characters, and nothing else`;
  if (!hasOnlySomeOf(req.body, IDENTITY_FIELDS)) return invalid(res, problem);
  const identity = {};
  for (const field of Object.keys(req.body)) {
    const value = req.body[field];
    if (typeof value !== 'string' || value.length > MAX_IDENTITY_CHARS || CONTROL_CHARS.test(value) || value.trim().length === 0) {
      return invalid(res, problem);
    }
    identity[field] = value.trim();
  }
  // The meeting's data went between the two checks, or it holds as many as it takes
  if (!presence.setIdentity(meetingId, req.user.id, identity)) return forbidden(res, NOT_AN_OWNER);
  return res.json({ stored: true });
});

/**
 * GET /identity-check
 * { lines, idEqualsParticipantId, idEqualsParticipantUUID, nameEqualsScreenName, identities }
 * Of the transcript lines stored since the first report (`lines`), how many
 * had a speaker id equal to a reported participantId or participantUUID, and
 * how many a speaker name equal to a reported screen name; `identities` is how
 * many owners reported. Numbers only.
 */
router.get('/identity-check', requireAuth, requireMeetingAccess, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  const presence = getArloPresence();
  if (!presence.isOwner(meetingId, req.user.id)) return forbidden(res, 'Only the person who brought Arlo in sees these.');
  return res.json(presence.identityCheck(meetingId));
});

module.exports = router;
