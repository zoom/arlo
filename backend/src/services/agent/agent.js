/**
 * The agent: what happens to a request to Arlo, typed in a panel or heard in
 * the meeting ("Arlo, …", services/agent/commandDetector.js).
 *
 * handle(meetingId, { text, channel, askedBy }) goes through these steps:
 *   1. Refused at once: a meeting without an owner, someone who may not type
 *      requests here, more than `rateLimit` requests in `rateWindowMs`, or the
 *      queue is full. One request is handled at a time per meeting and
 *      `queueLimit` wait; a spoken request that is turned away gets one line
 *      in the chat ("I am busy"), not one per request.
 *   2. A model picks one tool for the request (`choose`). What it answers is
 *      untrusted: the pick goes through validateToolCall() (the tool table,
 *      services/agent/tools.js), and anything that does not pass is "no tool".
 *      When the model cannot be asked: a typed request is treated as a
 *      question about the meeting, as typed; a spoken one is dropped and
 *      recorded for the owners as "Could not understand a request".
 *   3. The policy (services/agent/policy.js) says what happens: run, ask the
 *      owners, refuse, or stay silent. The model has no say in it.
 *   4. Asking the owners: the action is recorded as `waiting_approval`, an
 *      approval is opened (services/approvals.js, kind 'agent_action') and the
 *      owners' panels get the sheet. This request's turn ends there; when an
 *      owner agrees the run takes a turn of its own. "Not now" or no answer
 *      ends it, and a spoken request is told so in the chat.
 *   5. Running: tools of the server run here (an answer or summary from the
 *      stored transcript, sharing the notes); a tool of the panel goes to the
 *      hands (services/agent/hands.js). Each has `runLimitMs`.
 *   6. Delivering: the text for a typed request is returned to the caller;
 *      for a spoken one it is posted to the meeting chat through the hands,
 *      prefixed "Arlo: ".
 *   7. Recording: every request that got as far as a tool is an action in the
 *      meeting store, with a label from services/agent/texts.js. An answer to
 *      a typed request is private (`public: false`); everything spoken and
 *      everything that changes the meeting is public.
 *
 * Around steps 2 to 6 the owners' panels are told Arlo is thinking, and
 * always told when it stopped.
 *
 * handle() never rejects. It resolves to one of:
 *   { status: 'refused', reason }  'invalid' | 'no_owner' | 'not_allowed' | 'busy' | 'rate_limited' | 'gone'
 *   { status: 'none' }             no tool fits (also: a spoken non-request)
 *   { status: 'answered', tool, answer, action }
 *   { status: 'done', tool, reply, action }       `reply`: a sentence for the asker's panel
 *   { status: 'waiting_approval', tool, action }
 *   { status: 'failed', tool, code, action }
 * `action` is the stored action, or null when the record is full.
 *
 * Who sees an action (actionsFor, and the `did` message): a public one,
 * everyone in the meeting; a private answer, the owner who asked and nobody
 * else (not another owner; someone who is not an owner has no list); a spoken
 * request that was not understood, the owners.
 *
 * Per meeting this module holds a queue, times of recent requests, whose
 * private answers are whose, and whether thinking is on. No request, answer or
 * transcript text is kept, and none is logged: log lines carry a tool name and
 * an outcome. All of it goes with the meeting's data (forget(), called by the
 * meeting lifecycle), and every step that follows a wait checks first that the
 * store still holds the meeting: after a flush nothing is stored or sent.
 */
const { newestLines } = require('../../lib/transcriptLines');
const { cleanName } = require('../../lib/displayName');
const { getTool, validateToolCall, NO_TOOL_NAME } = require('./tools');
const { decide, panelMayAsk } = require('./policy');
const { approvalMessageData } = require('../approvals');
const {
  TOOL_TEXTS, NOT_UNDERSTOOD_LABEL, CHAT, CHAT_PREFIX,
} = require('./texts');

const MAX_ID_CHARS = 256;
const MAX_REQUEST_CHARS = 1000;
const MAX_NAME_CHARS = 200;
const MAX_ANSWER_CHARS = 4000;
const MAX_CHAT_MESSAGE_CHARS = 1000;
const MAX_CONTEXT_CHARS = 6000;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_MEETINGS = 5000;
// Notes this many lines behind the transcript are too old to be the summary
const NOTES_FRESH_WITHIN_LINES = 10;
// "I am busy" is said in the chat at most this often per meeting
const BUSY_LINE_EVERY_MS = 2 * 60 * 1000;
const SUMMARY_QUESTION = 'Summarize the meeting so far in a few sentences: what was discussed, what was decided, and what is still open.';
// What the hands can report (services/agent/hands.js); anything else is 'error'
const HANDS_CODES = new Set(['no_hands', 'timeout', 'gone', 'not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed']);
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
  // { run(meetingId, { tool, args }) -> Promise<{ ok: true } | { ok: false, code }> }
  hands,
  // ({ request, context }) -> Promise<{ tool, args } | { tool: 'none' }>; rejects when no model answered
  choose,
  // ({ question, lines }) -> Promise<string>
  answer,
  // (meetingId, ownerUserId) -> whether the notes are shared with everyone now
  shareNotes = () => false,
  // (meetingId, { speakerId, speakerLabel }) -> boolean; see services/agent/speakerMatch.js
  isVerifiedOwnerSpeaker = () => false,
  // What the panels are told. `thinking(meetingId, userIds, on)`,
  // `did(meetingId, action, { everyone, userIds })`, `approval(meetingId, userIds, data)`
  send = {},
  // Passed to the tool table: { webSearch } (tests)
  toolOptions,
  now = Date.now,
  schedule = defaultSchedule,
  log = console,
  queueLimit = 3,
  rateLimit = 30,
  rateWindowMs = 10 * 60 * 1000,
  chooseLimitMs = 20000,
  runLimitMs = 20000,
} = {}) {
  // meetingId -> {
  //   busy: a request is being handled, queue: [{ job, resolve }] waiting,
  //   recent: times of the requests taken in the last window,
  //   thinkingFor: the user ids told "thinking" is on, or null,
  //   privateAskers: Map(action id -> user id) for private answers,
  //   busySaidAt: when "I am busy" was last said in the chat,
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

  function setThinking(meetingId, state, on) {
    if (on) {
      const owners = ownersOf(meetingId);
      state.thinkingFor = owners;
      tellPanels('thinking', meetingId, owners, true);
    } else if (state.thinkingFor) {
      const told = state.thinkingFor;
      state.thinkingFor = null;
      tellPanels('thinking', meetingId, told, false);
    }
  }

  /** The meeting's data is gone: nothing of it is kept here, and nothing waiting is done. */
  function forget(meetingId) {
    const state = meetings.get(meetingId);
    if (!state) return;
    meetings.delete(meetingId);
    // The panels that were told Arlo is thinking are told it stopped
    setThinking(meetingId, state, false);
    for (const item of state.queue.splice(0)) item.resolve(GONE);
    state.privateAskers.clear();
    state.recent.length = 0;
    for (const done of state.idle.splice(0)) done();
  }

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      // A backstop only: a meeting normally leaves through forget()
      if (meetings.size >= MAX_MEETINGS) forget(meetings.keys().next().value);
      state = {
        busy: false, queue: [], recent: [], thinkingFor: null, privateAskers: new Map(), busySaidAt: -Infinity, idle: [],
      };
      meetings.set(meetingId, state);
    }
    return state;
  }

  /** `start()`'s promise, rejected with code 'timeout' when it takes longer than `ms`. */
  const limited = (start, ms) => new Promise((resolve, reject) => {
    const cancel = schedule(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    Promise.resolve()
      .then(start)
      .then((value) => { cancel(); resolve(value); }, (error) => { cancel(); reject(error); });
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

  const enqueue = (meetingId, state, job) => new Promise((resolve) => {
    state.queue.push({ job, resolve });
    pump(meetingId, state);
  });

  /** One hands call with the run limit, as { ok: true } or { ok: false, code }. Never throws. */
  async function viaHands(meetingId, call) {
    try {
      const result = await limited(() => hands.run(meetingId, call), runLimitMs);
      if (isPlainObject(result) && result.ok === true) return { ok: true };
      const known = isPlainObject(result) && result.ok === false && typeof result.code === 'string' && HANDS_CODES.has(result.code);
      return { ok: false, code: known ? result.code : 'error' };
    } catch (error) {
      return { ok: false, code: error && error.code === 'timeout' ? 'timeout' : 'error' };
    }
  }

  /** A line of Arlo's own in the meeting chat. Not waited for: if no panel can post it, nothing is said. */
  function sayInChat(meetingId, message) {
    viaHands(meetingId, { tool: 'post_to_chat', args: { message } }).catch(() => {});
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
      const text = await limited(() => answer({ question, lines }), runLimitMs);
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

  /** Do what the tool does: { ok: true, text? } or { ok: false, code }. Never throws. */
  async function runTool(meetingId, tool, args, actorUserId) {
    try {
      switch (tool.name) {
        case 'answer_from_meeting':
          return await answerWith(meetingId, args.question);
        case 'summarize_so_far': {
          const fromNotes = summaryFromNotes(meetingId);
          return fromNotes !== null ? { ok: true, text: fromNotes } : await answerWith(meetingId, SUMMARY_QUESTION);
        }
        case 'share_notes':
          // As an owner: the one who typed or approved it, else the first
          return shareNotes(meetingId, actorUserId ?? ownersOf(meetingId)[0] ?? null) === true
            ? { ok: true }
            : { ok: false, code: 'not_allowed' };
        default:
          // A tool of the panel goes to the hands; a tool of the server that
          // is not above (web search) is not built
          return tool.runs === 'panel'
            ? await viaHands(meetingId, { tool: tool.name, args })
            : { ok: false, code: 'unsupported' };
      }
    } catch {
      return { ok: false, code: 'error' };
    }
  }

  /** Run the tool, deliver its result, record how it ended. */
  async function runAndFinish(ctx, action, actorUserId) {
    const {
      meetingId, state, req, tool, args, alive,
    } = ctx;
    const result = await runTool(meetingId, tool, args, actorUserId);
    if (!alive()) return GONE;
    const hasText = result.ok && typeof result.text === 'string';
    let outcome = result;
    if (hasText && req.channel === 'voice') {
      // A spoken request is answered where everyone reads it
      const posted = await viaHands(meetingId, {
        tool: 'post_to_chat', args: { message: cut(`${CHAT_PREFIX}${result.text}`, MAX_CHAT_MESSAGE_CHARS) },
      });
      if (!alive()) return GONE;
      if (!posted.ok) outcome = posted;
    }
    const texts = TOOL_TEXTS[tool.name];
    const stored = action
      ? finish(meetingId, state, action.id, outcome.ok ? 'done' : 'failed', outcome.ok ? texts.done(args) : undefined)
      : null;
    log.log(`Arlo agent: ${tool.name} ${outcome.ok ? 'done' : `failed (${outcome.code})`} (${req.channel})`);
    if (!outcome.ok) {
      return {
        status: 'failed', tool: tool.name, code: outcome.code, action: stored,
      };
    }
    if (hasText) {
      return {
        status: 'answered', tool: tool.name, answer: result.text, action: stored,
      };
    }
    return {
      status: 'done', tool: tool.name, reply: texts.reply(args), action: stored,
    };
  }

  /** One turn in the meeting's queue with "thinking" on, and off again whatever happens. */
  async function thinkingWhile(meetingId, state, work) {
    if (meetings.get(meetingId) !== state || !store.has(meetingId)) return GONE;
    setThinking(meetingId, state, true);
    try {
      return await work();
    } finally {
      // After a flush forget() switched it off already
      if (meetings.get(meetingId) === state) setThinking(meetingId, state, false);
    }
  }

  /** The owners answered the sheet, or it ran out. */
  function ownersAnswered(ctx, action, outcome, byUserId) {
    const {
      meetingId, state, req, tool, alive,
    } = ctx;
    if (outcome === 'forgotten' || !alive()) return;
    if (outcome === 'approved') {
      // A turn of its own: other requests were handled while the owners decided
      enqueue(meetingId, state, () => thinkingWhile(meetingId, state, async () => {
        store.updateAction(meetingId, action.id, { status: 'pending' });
        return runAndFinish(ctx, action, isId(byUserId) ? byUserId : null);
      })).catch(() => {});
      return;
    }
    const status = outcome === 'declined' || outcome === 'expired' ? outcome : 'failed';
    finish(meetingId, state, action.id, status);
    log.log(`Arlo agent: ${tool.name} ${status} (${req.channel})`);
    if (req.channel === 'voice' && status !== 'failed') sayInChat(meetingId, CHAT[status]);
  }

  /** Record the request as waiting and put the sheet on the owners' panels. */
  function askOwners(ctx) {
    const {
      meetingId, state, req, tool, args,
    } = ctx;
    const texts = TOOL_TEXTS[tool.name];
    const action = store.appendAction(meetingId, {
      tool: tool.name, label: texts.asked(args), askedBy: req.name, channel: req.channel, status: 'waiting_approval', public: true,
    });
    if (!action) return refused('busy');
    const opened = approvals.open(meetingId, {
      kind: 'agent_action',
      askedByUserId: req.userId,
      askedByName: req.name,
      question: texts.question(args),
      primaryLabel: texts.primary(args),
      onOutcome: (outcome, by) => ownersAnswered(ctx, action, outcome, by ? by.byUserId : null),
    });
    if (!opened) {
      // The owners have as many questions open as they take
      const stored = finish(meetingId, state, action.id, 'failed');
      log.log(`Arlo agent: ${tool.name} failed (busy) (${req.channel})`);
      return {
        status: 'failed', tool: tool.name, code: 'busy', action: stored,
      };
    }
    const approval = approvals.get(meetingId, opened.id);
    if (approval) tellPanels('approval', meetingId, ownersOf(meetingId), approvalMessageData(meetingId, approval));
    log.log(`Arlo agent: ${tool.name} waiting for approval (${req.channel})`);
    return { status: 'waiting_approval', tool: tool.name, action };
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
    try {
      const context = newestLines(store.listSegments(meetingId), MAX_CONTEXT_CHARS).lines;
      picked = await limited(() => choose({ request: req.text, context }), chooseLimitMs);
    } catch (error) {
      pickFailed = true;
      // The code only, and only one that looks like a code: a message can quote the request
      const code = error && typeof error.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'error';
      log.warn(`Arlo agent: no tool could be picked (${code}) (${req.channel})`);
    }
    if (!alive()) return GONE;

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
      // Typed: the Ask input keeps answering questions about the meeting
      tool = getTool('answer_from_meeting', toolOptions);
      args = { question: req.text };
    } else if (isPlainObject(picked)) {
      const call = validateToolCall(picked.tool, picked.args, toolOptions);
      if (call.ok) {
        tool = getTool(picked.tool, toolOptions);
        args = call.args;
      }
    }

    const toolKind = tool === null ? 'none' : (tool.changesMeeting ? 'change' : 'read');
    const asker = askerOf(meetingId, req);
    const outcome = decide({
      channel: req.channel, asker, whoCanAsk: store.getMeta(meetingId).whoCanAsk, toolKind,
    });
    if (outcome === 'silent') return { status: 'none' };
    if (outcome === 'refuse') return tool === null ? { status: 'none' } : refused('not_allowed');

    const ctx = {
      meetingId, state, req, tool, args, alive,
    };
    if (outcome === 'sheet') return askOwners(ctx);

    const isPublic = req.channel === 'voice' || tool.changesMeeting;
    const action = store.appendAction(meetingId, {
      tool: tool.name, label: TOOL_TEXTS[tool.name].asked(args), askedBy: req.name, channel: req.channel, status: 'pending', public: isPublic,
    });
    // Nothing the meeting sees is done without a record of it
    if (!action && isPublic) return refused('busy');
    if (action && !isPublic) state.privateAskers.set(action.id, req.userId);
    return runAndFinish(ctx, action, asker === 'owner' ? req.userId : null);
  }

  /** A request is turned away before it is looked at. A spoken one is told so in the chat, now and then. */
  function turnAway(meetingId, state, req, reason) {
    const at = now();
    if (req.channel === 'voice' && at - state.busySaidAt >= BUSY_LINE_EVERY_MS) {
      state.busySaidAt = at;
      sayInChat(meetingId, CHAT.busy);
    }
    return refused(reason);
  }

  async function handle(meetingId, request) {
    try {
      const req = readRequest(request);
      if (!isId(meetingId) || req === null) return refused('invalid');
      if (!store.has(meetingId) || ownersOf(meetingId).length === 0) return refused('no_owner');
      if (req.channel === 'panel'
          && !panelMayAsk({ asker: askerOf(meetingId, req), whoCanAsk: store.getMeta(meetingId).whoCanAsk })) {
        return refused('not_allowed');
      }
      const state = stateFor(meetingId);
      const at = now();
      state.recent = state.recent.filter((time) => at - time < rateWindowMs);
      if (state.recent.length >= rateLimit) return turnAway(meetingId, state, req, 'rate_limited');
      if (state.busy && state.queue.length >= queueLimit) return turnAway(meetingId, state, req, 'busy');
      state.recent.push(at);
      return await enqueue(meetingId, state, () => thinkingWhile(meetingId, state, () => work(meetingId, state, req)));
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
