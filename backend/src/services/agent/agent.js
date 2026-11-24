/**
 * The agent: what happens to a request to Arlo, typed in a panel or heard in
 * the meeting ("Arlo, …", services/agent/commandDetector.js).
 *
 * THE GUARANTEE. Anyone in the meeting can speak, so the transcript is text an
 * attacker controls, and what a model writes is untrusted. Nothing is posted
 * to the meeting chat, and nothing else changes the meeting, unless an owner
 * has seen exactly what will be posted or done and pressed the button on
 * their own panel, or typed the request themselves in their own panel.
 *   - Every text for the chat goes through one function (postLine): it is
 *     cleaned (chatText, services/agent/texts.js), and it is either the body
 *     of a sheet an owner approved, posted byte for byte, or a message an
 *     owner typed themselves.
 *   - The model that picks a tool gets the request and the tool list, never
 *     the transcript or the notes: what people said cannot steer which tool
 *     runs or what its arguments are.
 *   - Arlo posts no line of its own ("busy", "the host declined"): how a
 *     request ended is in the record only.
 *
 * handle(meetingId, { text, channel, askedBy }) goes through these steps:
 *   1. Refused at once: a meeting without an owner, someone who may not type
 *      requests here, too many requests in `rateWindowMs` (spoken ones have a
 *      budget per meeting, `spokenRateLimit`; typed ones a budget per person
 *      per meeting, `typedRateLimit`: what people say can never use up what
 *      someone may type), or the queue is full. One request is handled at a
 *      time per meeting and
 *      `queueLimit` wait. A typed request waits ahead of the spoken ones that
 *      wait (someone sits at a panel for it), behind typed ones that came
 *      earlier, and never interrupts the request being handled.
 *      A spoken request while no owner has a panel open in the meeting
 *      (`hasOwnerPanel`) is dropped here, before any model is asked and
 *      without a record: nothing it leads to could be shown or approved.
 *   2. A model picks one tool for the request (`choose`), from the request
 *      alone. What it answers is untrusted: the pick goes through
 *      validateToolCall() (the tool table, services/agent/tools.js), and
 *      anything that does not pass is "no tool". For a typed request, "no
 *      tool" (the model said none, picked something invalid, or could not be
 *      asked) means a question about the meeting: it is answered from the
 *      transcript with the text as typed. A spoken request no tool fits is
 *      silent; one the model could not be asked about is dropped and recorded
 *      for the owners as "Could not understand a request".
 *   3. The policy (services/agent/policy.js) says what happens: run, ask the
 *      owners, refuse, or stay silent. The model has no say in it. A tool
 *      that changes the meeting runs for an owner's typed request only when
 *      what it would do is in what the owner typed (typedRequestCovers,
 *      read from the cleaned request the model was given); otherwise the
 *      owner gets the sheet too.
 *   4. A typed request that only reads (an answer, a summary) runs and its
 *      text is returned to the caller, private to the asker.
 *   5. A spoken request that only reads: the text is written first, cleaned,
 *      and becomes the body of a sheet ("Post Arlo's answer in the meeting
 *      chat?"). One sheet, whoever spoke and whatever "who can ask" says.
 *   6. Asking the owners: the action is recorded as `waiting_approval`, an
 *      approval is opened (services/approvals.js, kind 'agent_action') and
 *      the owners' panels get the sheet: the question, the body when text
 *      will be posted, what was asked, who asked and whether the server knows
 *      that. This request's turn ends there; when an owner agrees the run
 *      takes a turn of its own: the approved body is posted as it is (no
 *      model is asked again), or the tool runs. "Not now" or no answer ends
 *      it, in the record only.
 *   7. Tools of the server run here (an answer or summary from the stored
 *      transcript, sharing the notes); a tool of the panel goes to the hands
 *      (services/agent/hands.js), and only to a panel of the owner who typed
 *      the request or pressed the approval, never to another owner's. When
 *      that owner has no panel that can do it, it fails as 'no_hands'. A
 *      sheet for a tool that needs a host's panel (admitting, muting) is put
 *      only to the owners who have one open; with none there is no sheet and
 *      it fails at once. Inviting everyone is both, and always after the
 *      sheet, also for an owner's typed request: when no panel of the owner
 *      who agreed announced that it can invite, it fails as 'no_hands' and
 *      nothing is shared; otherwise the server shares the notes first (the
 *      same way as for share_notes), then that owner's panel sends the
 *      invitation; when the panel does not, the notes stay shared and the
 *      action ends as failed, saying both. Opening the notes for
 *      everyone goes the same way with that owner's panel starting Zoom's
 *      Collaborate mode; a panel that could not does nothing in its
 *      place, and the action ends as failed. Opening a ticket
 *      sends that owner's panel one URL, built here from the deployment's
 *      Jira base URL and the key the tool table rebuilt (lib/jira.js); when
 *      the panel opened it and could not bring up the share dialog
 *      ('share_failed'), the action ends as failed, saying both. Each run has `runLimitMs`; a model call still running
 *      then, or when the meeting's data goes, is aborted (an AbortSignal).
 *   8. Recording: every request that got as far as a tool is an action in the
 *      meeting store, with a label from services/agent/texts.js. An answer to
 *      a typed request is private (`public: false`); everything spoken and
 *      everything that changes the meeting is public.
 *
 * The notes feed a summary only when the result goes to an owner in private,
 * or while the notes are shared with everyone; otherwise the summary is
 * written from the transcript, which everyone in the meeting can read anyway.
 * (GET …/arlo/notes refuses the same people.)
 *
 * Around steps 2 to 7 panels are told Arlo is thinking, and always told when
 * it stopped: for a spoken request the owners' panels; for a typed one only
 * the owner who typed it (another owner must not learn that someone asked
 * something in private), and nobody when the asker is not an owner.
 * With "thinking" goes what Arlo is doing right now (`step`, a sentence from
 * the table in services/agent/texts.js, picked by where the run is and never
 * written by a model) and how it was asked (`channel`); when the step
 * changes they are told again. While a sheet waits for an owner Arlo is not
 * thinking: the approved run is a turn of its own, and says what it does.
 *
 * At most 5 sheets of the agent are open per meeting (services/approvals.js);
 * a request that would need one more is dropped and recorded as failed, "Too
 * many requests are waiting".
 *
 * handle() never rejects. It resolves to one of:
 *   { status: 'refused', reason }  'invalid' | 'no_owner' | 'not_allowed' | 'busy' | 'rate_limited' | 'gone'
 *   { status: 'none' }             a spoken request no tool fits, or one nobody's panel could show
 *   { status: 'answered', tool, answer, action }  typed only: the text, for the asker
 *   { status: 'done', tool, reply, action }       `reply`: a sentence for the asker's panel
 *   { status: 'waiting_approval', tool, action, askerIsAsked }  `askerIsAsked`: the sheet is on
 *                                  the panel of the owner who typed the request
 *   { status: 'failed', tool, code, action, reply? }  `reply`: a sentence for the asker's panel,
 *                                  when this failure has one of its own (services/agent/texts.js)
 * `action` is the stored action, or null when the record is full.
 *
 * Who sees an action (actionsFor, and the `did` message): a public one,
 * everyone in the meeting; a private answer, the owner who asked and nobody
 * else (not another owner; someone who is not an owner has no list); a spoken
 * request that was not understood, the owners.
 *
 * Per meeting this module holds a queue, times of recent requests, whose
 * private answers are whose, and whether thinking is on. No request, answer or
 * transcript text is kept beyond the turn it is used in (an answer that waits
 * for an owner is held by the approval, and goes with it), and none is logged:
 * log lines carry a tool name and an outcome. All of it goes with the
 * meeting's data (forget(), called by the meeting lifecycle), and every step
 * that follows a wait checks first that the store still holds the meeting:
 * after a flush nothing is stored or sent.
 */
const { newestLines } = require('../../lib/transcriptLines');
const { cleanName } = require('../../lib/displayName');
const {
  getTool, validateToolCall, jiraBaseUrl, NO_TOOL_NAME,
} = require('./tools');
const { ticketUrl } = require('../../lib/jira');
const {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers,
} = require('./policy');
const { approvalMessageData } = require('../approvals');
const {
  TOOL_TEXTS, NOT_UNDERSTOOD_LABEL, CHAT_PREFIX, isTimerMinutes, chatText, cleanLine, noHands, TOO_MANY_WAITING_LABEL,
  failedReply, INVITE_NOT_SENT, NOTES_NOT_OPENED, TICKET_SHARE_FAILED_LABEL,
  MAX_CHAT_ANSWER_CHARS, MAX_CHAT_MESSAGE_CHARS, MAX_SHEET_REQUEST_CHARS, MAX_SHEET_NAME_CHARS,
  STEPS, toolStep,
} = require('./texts');

const MAX_ID_CHARS = 256;
const MAX_REQUEST_CHARS = 1000;
const MAX_NAME_CHARS = 200;
const MAX_ANSWER_CHARS = 4000;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_MEETINGS = 5000;
// People whose typed requests are counted per meeting, and private answers remembered
const MAX_TYPED_ASKERS = 200;
const MAX_PRIVATE_ANSWERS = 500;
// Notes this many lines behind the transcript are too old to be the summary
const NOTES_FRESH_WITHIN_LINES = 10;
const SUMMARY_QUESTION = 'Summarize the meeting so far in a few sentences: what was discussed, what was decided, and what is still open.';
// What the hands can report (services/agent/hands.js); anything else is 'error'
const HANDS_CODES = new Set(['no_hands', 'timeout', 'gone', 'busy', 'not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed', 'share_failed']);
// The name the store gives a line without a speaker name: nobody's name
const NO_SPEAKER_NAME = 'Speaker';

const GONE = Object.freeze({ status: 'refused', reason: 'gone' });
const refused = (reason) => ({ status: 'refused', reason });

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cut = (value, max) => (value.length > max ? value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : value);
const stringOrNull = (value) => (typeof value === 'string' && value.length > 0 ? cut(value, MAX_NAME_CHARS) : null);

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
};

/**
 * A request rebuilt from its known fields, or null when it is not one.
 * Typed: askedBy { userId, name? }. Spoken: askedBy { speakerId?, speakerLabel? }.
 */
function readRequest(raw) {
  if (!isPlainObject(raw) || typeof raw.text !== 'string' || raw.text.length > MAX_REQUEST_CHARS) return null;
  const text = raw.text.trim();
  if (text.length === 0 || !isPlainObject(raw.askedBy)) return null;
  if (raw.channel === 'panel') {
    if (!isId(raw.askedBy.userId)) return null;
    return {
      text, channel: 'panel', userId: raw.askedBy.userId, name: cleanName(raw.askedBy.name) || null, speaker: null,
    };
  }
  if (raw.channel === 'voice') {
    const speakerLabel = stringOrNull(raw.askedBy.speakerLabel);
    return {
      text,
      channel: 'voice',
      userId: null,
      name: speakerLabel === NO_SPEAKER_NAME ? null : cleanName(speakerLabel) || null,
      speaker: { speakerId: stringOrNull(raw.askedBy.speakerId), speakerLabel },
    };
  }
  return null;
}

function createAgent({
  store,
  presence,
  approvals,
  // { run(meetingId, { tool, args, userId }) -> Promise<{ ok: true } | { ok: false, code }>: on a
  //   panel of that owner and nobody else's;
  //   whoCan(meetingId, tool) -> the owners who have a panel open that can run it }
  hands,
  // ({ request, signal }) -> Promise<{ tool, args } | { tool: 'none' }>; rejects when no model answered.
  // Given the request and nothing of the meeting. `signal` aborts when the time is up or the meeting is gone
  choose,
  // ({ question, lines, signal }) -> Promise<string>
  answer,
  // (meetingId, ownerUserId) -> whether the notes are shared with everyone now
  shareNotes = () => false,
  // (meetingId, { speakerId, speakerLabel }) -> boolean; see services/agent/speakerMatch.js
  isVerifiedOwnerSpeaker = () => false,
  // (meetingId, ownerUserIds) -> whether one of these owners has a panel open
  // in the meeting right now. Without it nothing spoken is heard.
  hasOwnerPanel = () => false,
  // What the panels are told. `thinking(meetingId, userIds, on, { step, channel })`
  // (the fourth only with `on` true; `step` is a sentence of texts.js or null),
  // `did(meetingId, action, { everyone, userIds })`, `approval(meetingId, userIds, data)`
  send = {},
  // Passed to the tool table: { webSearch, jiraBaseUrl } (tests)
  toolOptions,
  now = Date.now,
  schedule = defaultSchedule,
  log = console,
  queueLimit = 3,
  // Spoken requests per meeting, and typed requests per person per meeting, in `rateWindowMs`
  spokenRateLimit = 20,
  typedRateLimit = 30,
  rateWindowMs = 10 * 60 * 1000,
  chooseLimitMs = 20000,
  runLimitMs = 20000,
} = {}) {
  // meetingId -> {
  //   busy: a request is being handled, queue: [{ job, resolve }] waiting,
  //   spoken: times of the spoken requests taken in the last window,
  //   typed: Map(user id -> times of that person's typed requests in the last window),
  //   aborts: the AbortControllers of model calls that are running,
  //   thinkingFor: the user ids told "thinking" is on, or null,
  //   thinkingStep, thinkingChannel: what they were told last, while it is on,
  //   privateAskers: Map(action id -> user id) for private answers,
  //   idle: resolvers waiting for the queue to drain }
  const meetings = new Map();

  const tellPanels = (kind, ...args) => {
    try {
      if (typeof send[kind] === 'function') send[kind](...args);
    } catch {
      // A panel that cannot be told must not change what was decided or done
    }
  };

  function ownersOf(meetingId) {
    try {
      const ids = presence.ownerUserIds(meetingId);
      return Array.isArray(ids) ? ids.filter(isId) : [];
    } catch {
      return [];
    }
  }

  /** Whether an owner has a panel open in the meeting right now. A check that fails says no. */
  function ownerPanelOpen(meetingId) {
    try {
      return hasOwnerPanel(meetingId, ownersOf(meetingId)) === true;
    } catch {
      return false;
    }
  }

  /**
   * Who is told Arlo is thinking about this request. Spoken: the owners (it
   * was said in front of everyone). Typed: the owner who typed it and nobody
   * else, since what they ask is private; nobody when they are not an owner.
   */
  function thinkingAudience(meetingId, req) {
    const owners = ownersOf(meetingId);
    if (req.channel === 'voice') return owners;
    return owners.includes(req.userId) ? [req.userId] : [];
  }

  /** `step`: what Arlo does first, a sentence of services/agent/texts.js or null. */
  function setThinking(meetingId, state, on, req, step = null) {
    if (on) {
      const told = thinkingAudience(meetingId, req);
      state.thinkingFor = told;
      state.thinkingStep = step;
      state.thinkingChannel = req.channel;
      if (told.length > 0) tellPanels('thinking', meetingId, told, true, { step, channel: req.channel });
    } else if (state.thinkingFor) {
      const told = state.thinkingFor;
      state.thinkingFor = null;
      state.thinkingStep = null;
      state.thinkingChannel = null;
      if (told.length > 0) tellPanels('thinking', meetingId, told, false);
    }
  }

  /**
   * Arlo does something else now: the panels that were told it is thinking
   * are told what. Nothing when thinking is off, the step is the one they
   * have, or there is none (null). The step is never logged.
   */
  function setStep(meetingId, state, step) {
    if (typeof step !== 'string' || meetings.get(meetingId) !== state) return;
    if (!state.thinkingFor || state.thinkingStep === step) return;
    state.thinkingStep = step;
    if (state.thinkingFor.length > 0) {
      tellPanels('thinking', meetingId, state.thinkingFor, true, { step, channel: state.thinkingChannel });
    }
  }

  /** The meeting's data is gone: nothing of it is kept here, and nothing waiting is done. */
  function forget(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    meetings.delete(meetingId);
    // The panels that were told Arlo is thinking are told it stopped
    setThinking(meetingId, state, false);
    // A model still working on this meeting's text is stopped
    for (const controller of [...state.aborts]) controller.abort();
    state.aborts.clear();
    for (const item of state.queue.splice(0)) item.resolve(GONE);
    state.privateAskers.clear();
    state.spoken.length = 0;
    state.typed.clear();
    for (const done of state.idle.splice(0)) done();
  }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= MAX_MEETINGS) forget(meetings.keys().next().value);
      state = {
        busy: false,
        queue: [],
        spoken: [],
        typed: new Map(),
        aborts: new Set(),
        thinkingFor: null,
        thinkingStep: null,
        thinkingChannel: null,
        privateAskers: new Map(),
        idle: [],
      };
      meetings.set(meetingId, state);
    }
    return state;
  }

  /**
   * `start(signal)`'s promise, rejected with code 'timeout' when it takes
   * longer than `ms`. The signal aborts then, and when the meeting is
   * forgotten (`state` given), so a model call does not outlive its turn.
   */
  const limited = (start, ms, state = null) => new Promise((resolve, reject) => {
    const controller = new AbortController();
    if (state) state.aborts.add(controller);
    const settled = () => { if (state) state.aborts.delete(controller); };
    const cancel = schedule(() => {
      settled();
      controller.abort();
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, ms);
    Promise.resolve()
      .then(() => start(controller.signal))
      .then((value) => { cancel(); settled(); resolve(value); }, (error) => { cancel(); settled(); reject(error); });
  });

  async function pump(meetingId, state) {
    if (state.busy) return;
    state.busy = true;
    try {
      while (state.queue.length > 0) {
        const item = state.queue.shift();
        let result = GONE;
        try {
          if (meetings.get(meetingId) === state) result = await item.job();
        } catch {
          result = { status: 'failed', code: 'error', action: null };
        }
        item.resolve(result);
      }
    } finally {
      state.busy = false;
      for (const done of state.idle.splice(0)) done();
    }
  }

  /**
   * A turn in the meeting's queue. `first`: ahead of everything waiting that
   * is not `first` itself (a typed request ahead of spoken ones), in order of
   * arrival among its own. What is being handled is never interrupted.
   */
  const enqueue = (meetingId, state, job, { first = false } = {}) => new Promise((resolve) => {
    const item = { job, resolve, first: first === true };
    const behind = item.first ? state.queue.findIndex((waiting) => !waiting.first) : -1;
    if (behind === -1) state.queue.push(item);
    else state.queue.splice(behind, 0, item);
    pump(meetingId, state);
  });

  /**
   * One hands call with the run limit, as { ok: true } or { ok: false, code }.
   * `userId`: the owner who typed the request or pressed the approval; it
   * runs on a panel of theirs or not at all. Never throws.
   */
  async function viaHands(meetingId, call, userId) {
    if (!isId(userId)) return { ok: false, code: 'no_hands' };
    try {
      const result = await limited(() => hands.run(meetingId, { ...call, userId }), runLimitMs);
      if (isPlainObject(result) && result.ok === true) return { ok: true };
      const known = isPlainObject(result) && result.ok === false && typeof result.code === 'string' && HANDS_CODES.has(result.code);
      return { ok: false, code: known ? result.code : 'error' };
    } catch (error) {
      return { ok: false, code: error && error.code === 'timeout' ? 'timeout' : 'error' };
    }
  }

  /**
   * The one way text reaches the meeting chat: "Arlo: " and then `text`,
   * which must already be clean (what an owner saw on the sheet, or typed).
   * Text that cleaning would still change is not posted.
   */
  function postLine(meetingId, text, max, userId) {
    if (typeof text !== 'string' || chatText(text, max) !== text) return Promise.resolve({ ok: false, code: 'empty' });
    return viaHands(meetingId, { tool: 'post_to_chat', args: { message: `${CHAT_PREFIX}${text}` } }, userId);
  }

  /** Tell the panels that may see this action that it ended. */
  function tellDid(meetingId, state, action) {
    const owners = ownersOf(meetingId);
    if (action.public === true) {
      tellPanels('did', meetingId, action, { everyone: true, userIds: owners });
      return;
    }
    if (action.channel === 'voice') {
      tellPanels('did', meetingId, action, { everyone: false, userIds: owners });
      return;
    }
    const asker = state.privateAskers.get(action.id);
    if (asker !== undefined && owners.includes(asker)) {
      tellPanels('did', meetingId, action, { everyone: false, userIds: [asker] });
    }
  }

  /** The action ends: stored, and told. The stored action, or null. */
  function finish(meetingId, state, actionId, status, label) {
    const stored = store.updateAction(meetingId, actionId, label === undefined ? { status } : { status, label });
    if (stored) tellDid(meetingId, state, stored);
    return stored;
  }

  /** An answer from the stored transcript: { ok: true, text } or { ok: false, code }. */
  async function answerWith(meetingId, question) {
    const { lines } = newestLines(store.listSegments(meetingId), MAX_TRANSCRIPT_CHARS);
    if (lines.length === 0) return { ok: false, code: 'no_transcript' };
    try {
      const text = await limited((signal) => answer({ question, lines, signal }), runLimitMs, meetings.get(meetingId));
      // The model's answer is untrusted: text only, and bounded
      if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, code: 'model_error' };
      return { ok: true, text: cut(text.trim(), MAX_ANSWER_CHARS) };
    } catch (error) {
      if (error && error.code === 'timeout') return { ok: false, code: 'timeout' };
      return { ok: false, code: error && error.code === 'rate_limited' ? 'model_rate_limited' : 'model_error' };
    }
  }

  /** The notes as a summary, when they cover the meeting up to a few lines ago. Otherwise null. */
  function summaryFromNotes(meetingId) {
    const notes = store.getNotes(meetingId);
    if (!notes || typeof notes.summary !== 'string' || notes.summary.trim().length === 0) return null;
    const segments = store.listSegments(meetingId);
    const newest = segments.length > 0 ? segments[segments.length - 1].seqNo : 0;
    if (newest - notes.throughSeqNo > NOTES_FRESH_WITHIN_LINES) return null;
    const decisions = notes.decisions.length > 0 ? `\nDecisions: ${notes.decisions.join('; ')}` : '';
    return cut(`${notes.summary.trim()}${decisions}`, MAX_ANSWER_CHARS);
  }

  /**
   * Whether the notes may feed what this request is answered: only when the
   * answer goes to an owner in private (they typed it in their own panel), or
   * while the notes are shared with everyone, asked at this moment. A spoken
   * request is answered in the chat, so for it only sharing counts.
   */
  function notesMayFeed(meetingId, req, asker) {
    if (req.channel === 'panel' && asker === 'owner') return true;
    try {
      return store.getMeta(meetingId).notesShared === true;
    } catch {
      return false;
    }
  }

  /** Do what the tool does: { ok: true, text? } or { ok: false, code }. Never throws. */
  async function runTool(ctx, actorUserId) {
    const {
      meetingId, state, tool, args, req, asker,
    } = ctx;
    try {
      setStep(meetingId, state, toolStep(tool.name, args));
      switch (tool.name) {
        case 'answer_from_meeting':
          // From the transcript only, which everyone in the meeting can read
          return await answerWith(meetingId, args.question);
        case 'summarize_so_far': {
          const fromNotes = notesMayFeed(meetingId, req, asker) ? summaryFromNotes(meetingId) : null;
          return fromNotes !== null ? { ok: true, text: fromNotes } : await answerWith(meetingId, SUMMARY_QUESTION);
        }
        case 'post_to_chat':
          return await postLine(meetingId, args.message, MAX_CHAT_MESSAGE_CHARS, actorUserId);
        case 'share_notes':
          // As the owner who typed or approved it, and nobody else
          return isId(actorUserId) && shareNotes(meetingId, actorUserId) === true
            ? { ok: true }
            : { ok: false, code: 'not_allowed' };
        case 'invite_everyone': {
          // Two things, in this order, and only after an owner agreed on the
          // sheet. Before anything is shared: a panel of that owner must be
          // able to send the invitation, or nothing is done at all
          if (!isId(actorUserId)) return { ok: false, code: 'not_allowed' };
          if (!hostsAmong(meetingId, tool.name).includes(actorUserId)) return { ok: false, code: 'no_hands' };
          // The notes are shared first, the same way share_notes does it and
          // as the same owner ("it was so already" counts); when that cannot
          // be done nothing goes to a panel
          if (shareNotes(meetingId, actorUserId) !== true) return { ok: false, code: 'not_allowed' };
          const invited = await viaHands(meetingId, { tool: tool.name, args }, actorUserId);
          // The invitation was not sent: the notes stay shared, and the outcome says both
          return invited.ok ? invited : { ok: false, code: invited.code, sharedOnly: true };
        }
        case 'open_notes_for_everyone': {
          // The same two steps and the same order as inviting, and only after
          // an owner agreed on the sheet: a panel of that owner must have
          // announced that it can start Collaborate, or nothing is shared
          if (!isId(actorUserId)) return { ok: false, code: 'not_allowed' };
          if (!hostsAmong(meetingId, tool.name).includes(actorUserId)) return { ok: false, code: 'no_hands' };
          if (shareNotes(meetingId, actorUserId) !== true) return { ok: false, code: 'not_allowed' };
          // Nothing is asked with it: the panel gets no arguments
          const opened = await viaHands(meetingId, { tool: tool.name, args: {} }, actorUserId);
          // Not opened as a shared document: the notes stay shared, and the outcome says both
          return opened.ok ? opened : { ok: false, code: opened.code, sharedOnly: true };
        }
        case 'open_ticket': {
          // The one URL there is: the deployment's base, "/browse/", the key
          // the tool table rebuilt. Nothing a model or a speaker gave is in it
          // but that key. No base (the setting went), no URL: nothing is sent
          const url = ticketUrl(jiraBaseUrl(toolOptions), args.key);
          if (url === null || typeof args.share !== 'boolean') return { ok: false, code: 'unsupported' };
          return await viaHands(meetingId, { tool: tool.name, args: { url, key: args.key, share: args.share } }, actorUserId);
        }
        case 'set_timer':
          // The minutes once more, as the panel is sent them and nothing with them
          if (!isTimerMinutes(args.minutes)) return { ok: false, code: 'unsupported' };
          return await viaHands(meetingId, { tool: tool.name, args: { minutes: args.minutes } }, actorUserId);
        case 'stop_timer':
          return await viaHands(meetingId, { tool: tool.name, args: {} }, actorUserId);
        default:
          // A tool of the panel goes to the hands; a tool of the server that
          // is not above (web search) is not built
          return tool.runs === 'panel'
            ? await viaHands(meetingId, { tool: tool.name, args }, actorUserId)
            : { ok: false, code: 'unsupported' };
      }
    } catch {
      return { ok: false, code: 'error' };
    }
  }

  /** How a run ended, recorded and as handle() answers it. `text`: an answer for the asker's own panel. */
  function ended(ctx, action, outcome, text) {
    const {
      meetingId, state, req, tool, args,
    } = ctx;
    const texts = TOOL_TEXTS[tool.name];
    // A failure keeps the label of what was asked, but for the two the reader can do something about
    let failedLabel;
    if (!outcome.ok && outcome.code === 'no_hands') failedLabel = noHands(tool.name);
    if (!outcome.ok && outcome.code === 'busy') failedLabel = TOO_MANY_WAITING_LABEL;
    // What the asker's panel is answered, when this failure has a sentence of its own
    let reply = outcome.ok ? null : failedReply(tool.name, outcome.code, args);
    if (!outcome.ok && outcome.sharedOnly === true) {
      // Half of it was done: the record must not read as if nothing happened
      const half = tool.name === 'open_notes_for_everyone' ? NOTES_NOT_OPENED : INVITE_NOT_SENT;
      failedLabel = half;
      reply = half;
    }
    if (!outcome.ok && tool.name === 'open_ticket' && outcome.code === 'share_failed' && reply !== null) {
      // The ticket is open and the share dialog is not: the record says both,
      // without the key (everyone reads it); the asker's own answer has the key
      failedLabel = TICKET_SHARE_FAILED_LABEL;
    }
    const stored = action
      ? finish(meetingId, state, action.id, outcome.ok ? 'done' : 'failed', outcome.ok ? texts.done(args) : failedLabel)
      : null;
    log.log(`Arlo agent: ${tool.name} ${outcome.ok ? 'done' : `failed (${outcome.code})`} (${req.channel})`);
    if (!outcome.ok) {
      return {
        status: 'failed', tool: tool.name, code: outcome.code, action: stored, ...(reply !== null && { reply }),
      };
    }
    if (typeof text === 'string') {
      return {
        status: 'answered', tool: tool.name, answer: text, action: stored,
      };
    }
    return {
      status: 'done', tool: tool.name, reply: texts.reply(args), action: stored,
    };
  }

  /**
   * Run the tool and record how it ended. A text it wrote is returned to the
   * caller, never posted: this is the way of a typed request, and of a tool
   * an owner approved that posts nothing a model wrote.
   */
  async function runAndFinish(ctx, action, actorUserId) {
    const result = await runTool(ctx, actorUserId);
    if (!ctx.alive()) return GONE;
    // Only someone at a panel is handed a text; nothing spoken gets here with one
    const text = result.ok && typeof result.text === 'string' && ctx.req.channel === 'panel' ? result.text : undefined;
    return ended(ctx, action, result, text);
  }

  /**
   * One turn in the meeting's queue with "thinking" on, and off again whatever
   * happens. `step`: what Arlo does first in this turn.
   */
  async function thinkingWhile(meetingId, state, req, step, work) {
    if (meetings.get(meetingId) !== state || !store.has(meetingId)) return GONE;
    setThinking(meetingId, state, true, req, step);
    try {
      return await work();
    } finally {
      // After a flush forget() switched it off already
      if (meetings.get(meetingId) === state) setThinking(meetingId, state, false);
    }
  }

  /**
   * The owners answered the sheet, or it ran out. `body`: the text the sheet
   * showed for an answer a model wrote; then approving posts exactly that.
   */
  function ownersAnswered(ctx, action, outcome, byUserId, body) {
    const {
      meetingId, state, req, tool, args, alive,
    } = ctx;
    if (outcome === 'forgotten' || !alive()) return;
    if (outcome === 'approved') {
      // What the approved run does: posts the text the sheet showed, or runs the tool
      const step = body === null ? toolStep(tool.name, args) : STEPS.posting;
      // A turn of its own: other requests were handled while the owners decided
      enqueue(meetingId, state, () => thinkingWhile(meetingId, state, req, step, async () => {
        store.updateAction(meetingId, action.id, { status: 'pending' });
        // The owner who pressed the button: it runs on their panel, as them
        const approver = isId(byUserId) ? byUserId : null;
        if (body === null) return runAndFinish(ctx, action, approver);
        // The answer the owner saw, as it is: no model is asked again
        const posted = await postLine(meetingId, body, MAX_CHAT_ANSWER_CHARS, approver);
        return alive() ? ended(ctx, action, posted) : GONE;
      })).catch(() => {});
      return;
    }
    // Declined or ran out: recorded, and nothing is said in the chat about it
    const status = outcome === 'declined' || outcome === 'expired' ? outcome : 'failed';
    finish(meetingId, state, action.id, status);
    log.log(`Arlo agent: ${tool.name} ${status} (${req.channel})`);
  }

  /** The owners who have a panel open that can run this tool. A check that fails says nobody. */
  function hostsAmong(meetingId, toolName) {
    try {
      const able = hands.whoCan(meetingId, toolName);
      const owners = ownersOf(meetingId);
      return Array.isArray(able) ? owners.filter((id) => able.includes(id)) : [];
    } catch {
      return [];
    }
  }

  /** Whether the owners can be asked one more thing. A check that fails says no. */
  function roomForSheet(meetingId) {
    try {
      return approvals.hasRoom(meetingId, 'agent_action') === true;
    } catch {
      return false;
    }
  }

  /**
   * Record the request as waiting and put the sheet on the owners' panels.
   * `answer`: for a spoken request that only reads, the action it was recorded
   * under and the cleaned text a model wrote, which becomes the sheet's body.
   */
  function askOwners(ctx, answer = null) {
    const {
      meetingId, state, req, tool, args,
    } = ctx;
    const texts = TOOL_TEXTS[tool.name];
    // Who is asked: the owners; for a tool that needs a host's panel, only
    // the owners who have one open. It would run on the panel of whoever agrees
    const audience = tool.needsHost === true ? hostsAmong(meetingId, tool.name) : ownersOf(meetingId);
    const why = audience.length === 0 ? 'no_hands' : (roomForSheet(meetingId) ? null : 'busy');
    if (why !== null) {
      // No sheet: nobody could do it, or the owners have as many open as they take
      if (answer !== null) return ended(ctx, answer.action, { ok: false, code: why });
      const dropped = store.appendAction(meetingId, {
        tool: tool.name, label: texts.asked(args), askedBy: req.name, channel: req.channel, status: 'pending', public: true,
      });
      return dropped ? ended(ctx, dropped, { ok: false, code: why }) : refused('busy');
    }
    const action = answer !== null
      ? store.updateAction(meetingId, answer.action.id, { status: 'waiting_approval' })
      : store.appendAction(meetingId, {
        tool: tool.name, label: texts.asked(args), askedBy: req.name, channel: req.channel, status: 'waiting_approval', public: true,
      });
    if (!action) return refused('busy');
    // What will be posted: the answer a model wrote, or the message asked for
    const body = answer !== null ? answer.body : (tool.name === 'post_to_chat' ? args.message : null);
    const opened = approvals.open(meetingId, {
      kind: 'agent_action',
      askedByUserId: req.userId,
      // A spoken request's name is a Zoom display name: shown, short, and never taken as proof
      askedByName: cleanLine(req.name, MAX_SHEET_NAME_CHARS),
      askerVerified: ctx.askerVerified,
      channel: req.channel,
      question: texts.question(args),
      primaryLabel: texts.primary(args),
      body,
      request: cleanLine(req.text, MAX_SHEET_REQUEST_CHARS),
      ...(tool.needsHost === true && { forUserIds: audience }),
      onOutcome: (outcome, by) => ownersAnswered(ctx, action, outcome, by ? by.byUserId : null, answer !== null ? answer.body : null),
    });
    // The owners have as many questions open as they take after all
    if (!opened) return ended(ctx, action, { ok: false, code: 'busy' });
    const approval = approvals.get(meetingId, opened.id);
    if (approval) tellPanels('approval', meetingId, audience, approvalMessageData(meetingId, approval, now()));
    log.log(`Arlo agent: ${tool.name} waiting for approval (${req.channel})`);
    // Whether the sheet is on the panel of the person who typed the request:
    // an owner who is among those asked. Then they are told to look at it
    const askerIsAsked = req.channel === 'panel' && audience.includes(req.userId);
    return {
      status: 'waiting_approval', tool: tool.name, action, askerIsAsked,
    };
  }

  /**
   * A spoken request that only reads: the text is written now, cleaned, and
   * shown to the owners as what would be posted. Nothing is posted here.
   */
  async function answerThenAsk(ctx) {
    const {
      meetingId, state, req, tool, args, alive,
    } = ctx;
    const action = store.appendAction(meetingId, {
      tool: tool.name, label: TOOL_TEXTS[tool.name].asked(args), askedBy: req.name, channel: req.channel, status: 'pending', public: true,
    });
    // Nothing the meeting sees is prepared without a record of it
    if (!action) return refused('busy');
    // The owners have as many sheets open as they take: dropped before a model is asked
    if (!roomForSheet(meetingId)) return ended(ctx, action, { ok: false, code: 'busy' });
    const result = await runTool(ctx, null);
    if (!alive()) return GONE;
    // What a model wrote is untrusted: one line of plain text, bounded, or nothing
    const body = result.ok && typeof result.text === 'string' ? chatText(result.text, MAX_CHAT_ANSWER_CHARS) : null;
    if (body === null) return ended(ctx, action, result.ok ? { ok: false, code: 'empty' } : result);
    return askOwners(ctx, { action, body });
  }

  /** 'owner' or 'other', decided here: typed by an owner, or spoken by a speaker verified to be one. */
  function askerOf(meetingId, req) {
    try {
      if (req.channel === 'panel') return presence.isOwner(meetingId, req.userId) === true ? 'owner' : 'other';
      return isVerifiedOwnerSpeaker(meetingId, req.speaker) === true ? 'owner' : 'other';
    } catch {
      return 'other';
    }
  }

  /** Steps 2 to 7 for one request. */
  async function work(meetingId, state, req) {
    const alive = () => meetings.get(meetingId) === state && store.has(meetingId);

    let picked = null;
    let pickFailed = false;
    // The request alone, as one line of plain text: nothing of the transcript
    // or the notes, so what people said cannot steer the pick
    const request = cleanLine(req.text, MAX_REQUEST_CHARS);
    try {
      if (request !== null) {
        setStep(meetingId, state, STEPS.choosing);
        picked = await limited((signal) => choose({ request, signal }), chooseLimitMs, state);
      }
    } catch (error) {
      pickFailed = true;
      // The code only, and only one that looks like a code: a message can quote the request
      const code = error && typeof error.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'error';
      log.warn(`Arlo agent: no tool could be picked (${code}) (${req.channel})`);
    }
    if (!alive()) return GONE;
    // The owner's panel closed while the model was asked: nobody could see what follows
    const heard = req.channel === 'voice' ? ownerPanelOpen(meetingId) : null;
    if (req.channel === 'voice' && !voiceIsHeard({ ownerPanelOpen: heard })) return { status: 'none' };

    let tool = null;
    let args = null;
    if (pickFailed) {
      if (req.channel === 'voice') {
        // Dropped without a word in the meeting; the owners can see that it happened
        const stored = store.appendAction(meetingId, {
          tool: NO_TOOL_NAME, label: NOT_UNDERSTOOD_LABEL, askedBy: req.name, channel: 'voice', status: 'failed', public: false,
        });
        if (stored) tellDid(meetingId, state, stored);
        return {
          status: 'failed', tool: NO_TOOL_NAME, code: 'chooser', action: stored,
        };
      }
      // Typed: no tool, which the policy answers as a question about the meeting
    } else if (isPlainObject(picked)) {
      const call = validateToolCall(picked.tool, picked.args, toolOptions);
      if (call.ok) {
        tool = getTool(picked.tool, toolOptions);
        args = call.args;
      }
    }

    const toolKind = tool === null ? 'none' : (tool.changesMeeting ? 'change' : 'read');
    const asker = askerOf(meetingId, req);
    let outcome = decide({
      channel: req.channel, asker, whoCanAsk: store.getMeta(meetingId).whoCanAsk, toolKind, ownerPanelOpen: heard === true,
    });
    if (outcome === 'answer') {
      // The Ask input keeps answering questions about the meeting: the text
      // as typed, the asker's own words, not something a model made of them
      tool = getTool('answer_from_meeting', toolOptions);
      args = { question: req.text };
      outcome = tool === null ? 'refuse' : 'run';
    }
    if (outcome === 'silent') return { status: 'none' };
    if (outcome === 'refuse') return tool === null ? { status: 'none' } : refused('not_allowed');
    // An owner typed it, but a model wrote what would be done: when that is
    // not in the owner's own words, they get the sheet like anyone else
    // (read from the request as the model got it: cleaned, nothing invisible in it)
    if (outcome === 'run' && tool.changesMeeting && (request === null || !typedRequestCovers(request, tool.name, args))) outcome = 'sheet';

    const ctx = {
      meetingId,
      state,
      req,
      tool,
      args,
      alive,
      asker,
      // Whether the server knows who asked: signed in and typing, or a speaker verified to be an owner
      askerVerified: req.channel === 'panel' || asker === 'owner',
    };
    // Nothing spoken runs without the sheet, whatever was decided above
    if (req.channel === 'voice') return tool.changesMeeting ? askOwners(ctx) : answerThenAsk(ctx);
    if (outcome === 'sheet') return askOwners(ctx);

    const isPublic = tool.changesMeeting;
    const action = store.appendAction(meetingId, {
      tool: tool.name, label: TOOL_TEXTS[tool.name].asked(args), askedBy: req.name, channel: req.channel, status: 'pending', public: isPublic,
    });
    // Nothing the meeting sees is done without a record of it
    if (!action && isPublic) return refused('busy');
    if (action && !isPublic) {
      // Bounded like the record itself: the oldest goes first
      if (state.privateAskers.size >= MAX_PRIVATE_ANSWERS) state.privateAskers.delete(state.privateAskers.keys().next().value);
      state.privateAskers.set(action.id, req.userId);
    }
    return runAndFinish(ctx, action, asker === 'owner' ? req.userId : null);
  }

  /**
   * The budget this request counts against, with the times still inside the
   * window: { times, limit }. Spoken requests share one per meeting; typed
   * ones have one per person, so nothing said in the meeting can use up what
   * someone may type. null when the meeting already counts as many people as
   * it takes (then the request is turned away).
   */
  function budgetFor(state, req) {
    const at = now();
    const recent = (times) => times.filter((time) => at - time < rateWindowMs);
    if (req.channel === 'voice') {
      state.spoken = recent(state.spoken);
      return { times: state.spoken, limit: spokenRateLimit };
    }
    for (const [userId, times] of state.typed) {
      const kept = recent(times);
      if (kept.length === 0) state.typed.delete(userId);
      else state.typed.set(userId, kept);
    }
    if (!state.typed.has(req.userId)) {
      if (state.typed.size >= MAX_TYPED_ASKERS) return null;
      state.typed.set(req.userId, []);
    }
    return { times: state.typed.get(req.userId), limit: typedRateLimit };
  }

  async function handle(meetingId, request) {
    try {
      const req = readRequest(request);
      if (!isId(meetingId) || req === null) return refused('invalid');
      if (!store.has(meetingId) || ownersOf(meetingId).length === 0) return refused('no_owner');
      // Spoken while no owner has Arlo open: dropped before any model call, recorded as nothing
      if (req.channel === 'voice' && !voiceIsHeard({ ownerPanelOpen: ownerPanelOpen(meetingId) })) return { status: 'none' };
      if (req.channel === 'panel'
          && !panelMayAsk({ asker: askerOf(meetingId, req), whoCanAsk: store.getMeta(meetingId).whoCanAsk })) {
        return refused('not_allowed');
      }
      const state = stateFor(meetingId);
      const budget = budgetFor(state, req);
      // Turned away without a word in the chat: nobody approved one
      if (budget === null || budget.times.length >= budget.limit) return refused('rate_limited');
      if (state.busy && state.queue.length >= queueLimit) return refused('busy');
      budget.times.push(now());
      // Someone waits at a panel for a typed request: it goes ahead of the spoken ones
      // A spoken request was heard; a typed one goes straight to the model that picks a tool
      const step = req.channel === 'voice' ? STEPS.heard : STEPS.choosing;
      return await enqueue(
        meetingId, state, () => thinkingWhile(meetingId, state, req, step, () => work(meetingId, state, req)), { first: req.channel === 'panel' },
      );
    } catch {
      return { status: 'failed', code: 'error', action: null };
    }
  }

  /**
   * The meeting's actions this person may see, oldest first. `userId` is the
   * signed-in Arlo user, or null.
   */
  function actionsFor(meetingId, userId) {
    if (!isId(meetingId)) return [];
    let owner = false;
    try {
      owner = isId(userId) && presence.isOwner(meetingId, userId) === true;
    } catch {
      owner = false;
    }
    const state = meetings.get(meetingId);
    return store.listActions(meetingId).filter((action) => {
      if (action.public === true) return true;
      if (!owner) return false;
      // A spoken request that was not understood is for the owners; a private
      // answer is for the owner who asked
      if (action.channel === 'voice') return true;
      return state !== undefined && state.privateAskers.get(action.id) === userId;
    });
  }

  /** Resolves when nothing of this meeting is being handled or waits for its turn. */
  function whenIdle(meetingId) {
    const state = meetings.get(meetingId);
    if (!state || (!state.busy && state.queue.length === 0)) return Promise.resolve();
    return new Promise((resolve) => { state.idle.push(resolve); });
  }

  return {
    handle, actionsFor, forget, whenIdle, holds: (meetingId) => meetings.has(meetingId), size: () => meetings.size,
  };
}

module.exports = { createAgent };
