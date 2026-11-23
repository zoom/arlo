/**
 * Arlo's routes for one meeting, mounted at
 * /api/meetings/by-zoom-id/:zoomMeetingId/arlo
 *
 *   GET  /state     what this panel is told: is Arlo here, and what is this person to it
 *   PUT  /settings  { whoCanAsk?: 'owner' | 'anyone', displayName?: string }, owners only
 *   GET  /notes     the live notes, owners only
 *   POST /ask       { question }: an answer from the stored transcript, private to the asker
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
const { broadcastArloState } = require('../services/websocket');
const { newestLines } = require('../lib/transcriptLines');
const { showableName } = require('../lib/displayName');
// Through the module object, so tests can replace the model call
const openrouter = require('../services/openrouter');

const router = express.Router({ mergeParams: true });

const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const MAX_QUESTION_CHARS = 500;
const MAX_DISPLAY_NAME_CHARS = 100;
const SETTINGS_FIELDS = ['whoCanAsk', 'displayName'];
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_ANSWER_CHARS = 4000;
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

/**
 * GET /state
 * { present, paused, role: 'owner' | 'participant', ownerName, whoCanAsk }
 * Open to guests in the meeting: a guest is a participant.
 */
router.get('/state', optionalAuth, requireMeetingAccess, (req, res) => {
  res.json(getArloPresence().stateFor(req.params.zoomMeetingId, req.user?.id ?? null));
});

/**
 * PUT /settings
 * { whoCanAsk?, displayName? }: at least one, nothing else.
 * `whoCanAsk` changes who may ask Arlo. `displayName` is the caller's own name
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
    return invalid(res, 'Send whoCanAsk, displayName, or both, and nothing else');
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
  return res.json(presence.stateFor(meetingId, req.user.id));
});

/**
 * GET /notes
 * { notes: { summary, decisions, actionItems, updatedAt, throughSeqNo } | null }
 */
router.get('/notes', requireAuth, requireMeetingAccess, (req, res) => {
  const meetingId = req.params.zoomMeetingId;
  if (!getArloPresence().isOwner(meetingId, req.user.id)) {
    return forbidden(res, 'The notes are for the person who brought Arlo in.');
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

module.exports = router;
