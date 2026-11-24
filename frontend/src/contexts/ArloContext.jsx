import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useMeeting } from './MeetingContext';
import { useAuth } from './AuthContext';
import { cleanNotes } from '../lib/notesText';
import { readMeetingMessage } from '../lib/meetingMessage';
import { usableName } from '../lib/ownerName';
import { identityReport } from '../lib/arloIdentity';
import { parseApproval, approvalTimeLeft } from '../lib/approvalKinds';
import { handsFor, runArloAction } from '../lib/arloActions';
import { parseAction, mergeActions } from '../lib/arloDid';
import { readThinkingStep, readThinkingChannel } from '../lib/thinkingStep';
import { useZoomSdk } from './ZoomSdkContext';

/**
 * What this panel knows about Arlo in the current meeting: is it here, what is
 * this person to it (owner or participant), the live notes (the owner's, and
 * everyone's while an owner shares them), and the private "ask". The server decides all of it; this only holds what it said.
 *
 * - State comes from GET …/arlo/state once meeting access is verified, and
 *   from `arlo.state` on the meeting socket afterwards.
 * - Notes come from GET …/arlo/notes and `notes.updated`: for an owner always,
 *   and for everyone else (a signed-in participant or a guest) only while the
 *   server says the notes are shared (`notesShared`). Becoming someone who may
 *   see them fetches them; the moment sharing stops, or the state says so,
 *   a non-owner's notes are dropped and later ones are not kept.
 *   `setShareNotes(true | false)` is the owner's switch.
 * - A message for another meeting id is ignored (an owner's socket can be
 *   told about another meeting).
 * - Routes and messages go by the meeting id the server verified
 *   (`verifiedMeetingId`), not the one read from the Zoom SDK: the two can
 *   differ. The SDK's id only says when the panel moved to another meeting.
 * - When the meeting ends the server deletes its data and says so: role
 *   'participant', no owner, nothing shared. The panel keeps what it had, so
 *   the notes on screen (the owner's, or the shared ones a participant was
 *   reading) stay until another meeting is opened.
 * - Leaving the meeting is the same for this panel as the meeting ending
 *   (`meetingOver`): the server's word may never arrive, the socket is closed.
 * - While notes are held, the meeting's transcript and timeline are
 *   held with them (MeetingContext), so the meeting record still opens.
 *
 * - `paused` is about the meeting (true only when every live stream in it is
 *   paused); `myStreamPaused` is about this person's own stream. Several people
 *   can each run a stream in one meeting.
 * - `myStreamLive` is the server's word on whether a stream of this person's
 *   own runs right now (owners only): false while Arlo is in the meeting only
 *   through another person's stream, null when the server did not say.
 * - What is held belongs to the signed-in person: when they stop being signed
 *   in (sign-out, session loss, deauthorization) or someone else is signed in,
 *   the state, the notes and the way back to them are dropped. An owner is
 *   always signed in: without a session the role is never 'owner'.
 *
 * - `ownerName` is null when the server has no name for the owner (a blank
 *   counts as none). An owner's panel then tells the server this person's Zoom
 *   screen name, once per meeting; the server shows it only when the account
 *   has no name of its own, and deletes it with the meeting.
 *
 * - Approvals: someone asks the owners for something (today: to share the
 *   notes with everyone in the meeting; the server does it when an owner agrees). An owner's panel reads the open ones from
 *   GET …/arlo/approvals when it learns it is an owner, and keeps them in step
 *   from `arlo.approval` / `arlo.approval.closed`: `approvals`, oldest first,
 *   without duplicates and without those past their time. Only an owner holds
 *   any. `answerApproval` reports the owner's answer. An approval's
 *   `expiresAt` here is by this panel's clock, counted from when it was
 *   received (lib/approvalKinds.js approvalTimeLeft): the server's clock and
 *   the panel's can be minutes apart.
 * - A read the server refuses (401 or 403 from …/arlo/state or …/arlo/notes)
 *   takes away the shared notes a non-owner holds. An owner's own notes stay.
 * - A participant's own request for the notes is `notesRequest`: null, or
 *   where it stands. The outcome comes as `arlo.approval.closed` for the id
 *   the server gave it; it clears by itself two minutes after it ended, and at
 *   once when the notes are shared (they are on screen then).
 *
 * - Hands: an owner's panel tells the server over the socket what it can do
 *   with the Zoom Apps SDK (`arlo.hands`: the Zoom role, and the tools from
 *   lib/arloActions.js handsFor), once the server spoke on that socket, and
 *   again when either changes; someone who stops being an owner clears it.
 *   An `arlo.action` for this meeting is run once (a repeated `actionId` is
 *   ignored) and its result reported to …/arlo/actions/<id>/result. A report
 *   that does not reach the server is sent again (RESULT_RETRY_MS) while this
 *   panel may still act; Zoom is never asked twice. Only an owner's panel
 *   runs anything, and not after the meeting is over.
 *
 * - `actions`: what Arlo was asked and did in this meeting, oldest first
 *   (lib/arloDid.js). Read from GET …/arlo/actions once access is verified
 *   and the state is known, kept in step by `arlo.did`; one entry per id. The
 *   server gives everyone the public ones and an owner their own private ones
 *   too; a private one is not kept by a panel that is not an owner's. Cleared
 *   with the meeting like the notes, and kept after the meeting only by
 *   someone who holds notes (the meeting record is kept on the same rule).
 * - `thinking`: Arlo is handling a request (`arlo.thinking`, to owners). Off
 *   when the server says so, and by itself THINKING_MS after the last "on".
 *   MeetingContext is told, for Zoom's indicator. `thinkingStep`: what the
 *   server says Arlo is doing right now ("Writing an answer"), or null;
 *   `thinkingChannel`: 'voice' when the request was said in the meeting,
 *   'panel' when typed, or null. Both read as untrusted input
 *   (lib/thinkingStep.js), replaced by every "on" and gone with "off". Zoom's
 *   indicator never gets the step: everyone in the meeting sees it.
 * - `ask` answers { answer } or { answer, action: { id, tool, status } } when
 *   the request was something to do: status 'done', 'failed' or
 *   'waiting_approval'. `id` is the action's, as in `actions`.
 *
 * Nothing here is logged: state, notes, questions and answers are meeting content.
 */
const ArloContext = createContext();

const ROLES = new Set(['owner', 'participant']);
const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const MAX_QUESTION_CHARS = 500;
// The longest display name the server takes from a panel
const MAX_SUPPLIED_NAME_CHARS = 100;
const MAX_ANSWER_CHARS = 4000;
// After a stream started: how long to wait for the server to say whose it is
const STATE_AFTER_START_MS = 3000;

// `present` and `role` are null until the server answered: "not known" is not "not here"
const NOT_LOADED = Object.freeze({
  loaded: false, present: null, paused: false, myStreamPaused: false, myStreamLive: null, role: null, ownerName: null, whoCanAsk: 'owner',
  notesShared: false,
});

/** Who holds notes: an owner, and everyone while the owners share them. */
const mayHoldNotes = (state) => state.role === 'owner' || state.notesShared === true;

// How many approvals an owner's panel holds at once (the server allows 20 open per meeting)
const MAX_APPROVALS = 20;
// The ids of approvals that ended, so one that is announced late is not shown again
const MAX_CLOSED_REMEMBERED = 100;
// After a request for the notes ended, the participant may ask again in this long (the server's rule)
const ASK_NOTES_AGAIN_MS = 2 * 60 * 1000;
// A request that ran out without the server saying so (the socket was away)
const NOTES_REQUEST_LATE_MS = 3000;
const NOTES_OUTCOMES = {
  approved: 'shared', declined: 'declined', expired: 'expired', failed: 'failed',
};
// The longest text from the server this panel shows for a request it would not take
const MAX_SERVER_MESSAGE_CHARS = 200;
const NOTES_REQUEST_MESSAGES = {
  409: 'Arlo isn\'t taking notes for anyone right now.',
  429: 'You asked a moment ago. Give it a couple of minutes.',
  failed: 'Couldn\'t ask for the notes. Try again.',
};

const ASK_MESSAGES = {
  empty: 'Type a question first.',
  tooLong: `Keep the question under ${MAX_QUESTION_CHARS} characters.`,
  busy: 'Arlo is still answering.',
  noMeeting: 'Open Arlo in a meeting to ask.',
  401: 'Sign in to ask Arlo.',
  403: 'You can\'t ask Arlo in this meeting.',
  409: 'Nothing has been said since Arlo joined.',
  429: 'Arlo is busy. Try again in a moment.',
  failed: 'Arlo could not answer right now.',
};

/** The state object the server sends, rebuilt from known fields. null when it is not one. */
function parseState(data) {
  if (data === null || typeof data !== 'object') return null;
  if (typeof data.present !== 'boolean' || !ROLES.has(data.role)) return null;
  return {
    present: data.present,
    paused: data.paused === true,
    // Absent from a server that does not tell the streams apart yet: false
    myStreamPaused: data.myStreamPaused === true,
    // Owners only. null: the server did not say (a participant, or an older server)
    myStreamLive: data.role === 'owner' && typeof data.myStreamLive === 'boolean' ? data.myStreamLive : null,
    role: data.role,
    ownerName: usableName(data.ownerName),
    whoCanAsk: WHO_CAN_ASK.has(data.whoCanAsk) ? data.whoCanAsk : 'owner',
    // Absent from a server that does not share notes yet: not shared
    notesShared: data.notesShared === true,
  };
}

const REFUSED = new Set([401, 403]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The longest Zoom role the server takes in an announcement
const MAX_ZOOM_ROLE_CHARS = 32;
// The ids of the actions this panel was sent, so one that is sent again is not run again
const MAX_ACTIONS_REMEMBERED = 200;
const SOCKET_OPEN = 1;
// "Arlo is thinking…" ends by itself this long after the last "on"
const THINKING_MS = 30 * 1000;
const NO_ACTIONS = Object.freeze([]);
// How a typed request for something to do can stand when the server answers
const ASK_ACTION_STATUSES = new Set(['done', 'failed', 'waiting_approval']);
const MAX_TOOL_CHARS = 64;
const MAX_ACTION_ID_CHARS = 64;
// A result the server did not take is reported again after these waits, then given up
const RESULT_RETRY_MS = [1000, 3000, 7000];
// The server may take it next time: it failed, was busy, or timed out. Any
// other refusal is its answer.
const reportAgainAfter = (status) => status >= 500 || status === 429 || status === 408;

/** What the server's clock said when it answered (the `Date` header), in ms; null when it did not say. */
function serverClock(res) {
  const at = Date.parse(res.headers?.get?.('Date') ?? '');
  return Number.isFinite(at) ? at : null;
}

/** The server's own words for a refusal, when they are short text; null otherwise. Shown as text only. */
function shortServerMessage(data) {
  const text = typeof data?.message === 'string' ? data.message.trim() : '';
  return text.length > 0 && text.length <= MAX_SERVER_MESSAGE_CHARS ? text : null;
}

const arloUrl = (meetingId, name) => `/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${name}`;

export function ArloProvider({ children }) {
  const {
    ws, meetingId, verifiedMeetingId, meetingAccess, meetingEnded, leftMeeting, lastMeetingId, switchingMeeting,
    setRecordRetained, setArloThinking,
  } = useMeeting();
  // The id for everything asked of the server and accepted from it; none before
  // access is verified or out of the meeting
  const serverMeetingId = meetingId ? verifiedMeetingId : null;
  // Over for this panel: Zoom said the meeting ended, or this person left it
  const meetingOver = meetingEnded === true || leftMeeting === true;
  const { isAuthenticated, user } = useAuth();
  const { userContext, zoomSdk, chatSupported, waitingRoomSupported } = useZoomSdk();
  // This person's role in the Zoom meeting, as Zoom reports it
  const zoomRole = typeof userContext?.role === 'string' && userContext.role.length > 0
    && userContext.role.length <= MAX_ZOOM_ROLE_CHARS ? userContext.role : 'attendee';
  const zoomRoleRef = useRef(zoomRole);
  zoomRoleRef.current = zoomRole;
  const zoomSdkRef = useRef(zoomSdk);
  zoomSdkRef.current = zoomSdk;
  // Who is signed in; null when nobody is
  const identity = isAuthenticated ? String(user?.id ?? '') : null;
  const signedInRef = useRef(isAuthenticated);
  signedInRef.current = isAuthenticated;
  const accessVerified = meetingAccess?.status === 'verified';

  const [state, setState] = useState(NOT_LOADED);
  const [everPresent, setEverPresent] = useState(false);
  const [notes, setNotes] = useState(null);
  // The notes route has answered for this meeting (an owner without notes is known then)
  const [notesAnswered, setNotesAnswered] = useState(false);
  // The server said a stream started and has not yet sent the state that follows it
  const [awaitingState, setAwaitingState] = useState(false);
  const [asking, setAsking] = useState(false);
  // Requests waiting for this owner's answer, oldest first
  const [approvals, setApprovals] = useState([]);
  // This participant's own request for the notes: null, or where it stands
  const [notesRequest, setNotesRequest] = useState(null);
  const [requestingNotes, setRequestingNotes] = useState(false);

  // What Arlo was asked and did in this meeting, oldest first
  const [actions, setActions] = useState(NO_ACTIONS);
  // Arlo is handling a request: null, or { step, channel } as the last "on"
  // said. A new object per "on", so each restarts the wait
  const [thinkingNow, setThinkingNow] = useState(null);
  // The socket the server has spoken on about this meeting: it is subscribed
  const [liveSocket, setLiveSocket] = useState(null);

  // Read by the socket handler, which must not wait for a render
  const ranActionsRef = useRef(new Set());
  const resultTimersRef = useRef(new Set());
  const handsSentRef = useRef({ socket: null, json: null });
  const stateRef = useRef(NOT_LOADED);
  const endedRef = useRef(false);
  const askingRef = useRef(false);
  const closedApprovalsRef = useRef(new Map()); // id -> outcome, the newest MAX_CLOSED_REMEMBERED
  const requestingNotesRef = useRef(false);
  const notesRequestRef = useRef(null);

  const putNotesRequest = useCallback((value) => {
    notesRequestRef.current = value;
    setNotesRequest(value);
  }, []);

  /** Nothing of the approvals or of a request for the notes is held any more. */
  const dropApprovals = useCallback(() => {
    closedApprovalsRef.current = new Map();
    setApprovals([]);
    putNotesRequest(null);
  }, [putNotesRequest]);
  const serverMeetingIdRef = useRef(serverMeetingId);
  serverMeetingIdRef.current = serverMeetingId;
  // The meeting this state belongs to. Leaving the meeting (no id) keeps it;
  // only another meeting replaces it.
  const heldMeetingIdRef = useRef(null);

  useEffect(() => {
    if (!meetingId || heldMeetingIdRef.current === meetingId) return;
    const hadMeeting = heldMeetingIdRef.current !== null;
    heldMeetingIdRef.current = meetingId;
    if (!hadMeeting) return;
    stateRef.current = NOT_LOADED;
    endedRef.current = false;
    setState(NOT_LOADED);
    setEverPresent(false);
    setNotes(null);
    setNotesAnswered(false);
    setAwaitingState(false);
    setActions(NO_ACTIONS);
    setThinkingNow(null);
    ranActionsRef.current = new Set();
    dropApprovals();
  }, [meetingId, dropApprovals]);

  // The person signed out, lost the session, was deauthorized, or someone else
  // is signed in: nothing held for the person before may show any more. With
  // no notes held, MeetingContext drops the kept transcript and timeline too.
  const identityRef = useRef(identity);
  useEffect(() => {
    const previous = identityRef.current;
    identityRef.current = identity;
    if (previous === null || previous === identity) return;
    stateRef.current = NOT_LOADED;
    setState(NOT_LOADED);
    setEverPresent(false);
    setNotes(null);
    setNotesAnswered(false);
    setAwaitingState(false);
    setActions(NO_ACTIONS);
    setThinkingNow(null);
    dropApprovals();
  }, [identity, dropApprovals]);

  useEffect(() => {
    if (!awaitingState) return undefined;
    const timer = setTimeout(() => setAwaitingState(false), STATE_AFTER_START_MS);
    return () => clearTimeout(timer);
  }, [awaitingState]);

  useEffect(() => {
    endedRef.current = meetingOver;
  }, [meetingOver]);

  const applyState = useCallback((data) => {
    const parsed = parseState(data);
    if (!parsed) return;
    // Only a signed-in person owns a stream. A socket opened before the session
    // ended can still be told "owner": that is no longer this panel's role.
    const next = signedInRef.current || parsed.role !== 'owner'
      ? parsed
      : { ...parsed, role: 'participant', myStreamPaused: false, myStreamLive: null };
    const prev = stateRef.current;
    // After the meeting ended the server has nothing left to say about it:
    // Arlo is gone, and who this person was to it stays as it was.
    const merged = endedRef.current && prev.loaded
      ? { ...prev, present: false, paused: false, myStreamPaused: false, myStreamLive: prev.myStreamLive === null ? null : false }
      : { loaded: true, ...next };
    stateRef.current = merged;
    setState(merged);
    if (merged.present) setEverPresent(true);
  }, []);

  // The server refused a read (401, 403): shared notes held by someone who is
  // not an owner go. An owner's own notes follow their own rules.
  const dropRefusedNotes = useCallback(() => {
    if (stateRef.current.role === 'owner' && signedInRef.current) return;
    setNotes(null);
  }, []);

  // The state again, when something says it changed and the socket's word may
  // have been missed. Silent: the socket's `arlo.state` is the usual way.
  const refreshState = useCallback(() => {
    const id = serverMeetingIdRef.current;
    if (!id) return;
    fetch(arloUrl(id, 'state'), { credentials: 'include' })
      .then((res) => {
        if (REFUSED.has(res.status) && serverMeetingIdRef.current === id) dropRefusedNotes();
        return res.ok ? res.json() : null;
      })
      .then((data) => { if (data && serverMeetingIdRef.current === id) applyState(data); })
      .catch(() => {});
  }, [applyState, dropRefusedNotes]);

  // Newer notes win. Notes for someone who may not see them are not kept: an
  // owner is always signed in; anyone else holds notes only while they are shared
  const applyNotes = useCallback((value) => {
    const clean = cleanNotes(value);
    if (!clean) return;
    const current = stateRef.current;
    const asOwner = current.role === 'owner' && signedInRef.current;
    if (!asOwner && current.notesShared !== true) return;
    setNotes((prev) => (
      prev && prev.throughSeqNo !== null && clean.throughSeqNo !== null && prev.throughSeqNo > clean.throughSeqNo
        ? prev
        : clean
    ));
  }, []);

  // A request for this owner's answer. Kept once, oldest first; not for someone
  // who is not an owner, not when it already ended or is past its time.
  // `fetched`: read from the server (an older one), not just announced on the
  // socket; `serverNow`: the server's clock when it answered, if it said.
  // Held with `expiresAt` by this panel's clock, counted from now.
  const addApprovals = useCallback((values, { fetched = false, serverNow = null } = {}) => {
    if (stateRef.current.role !== 'owner' || !signedInRef.current) return;
    const now = Date.now();
    const fresh = (Array.isArray(values) ? values : []).map(parseApproval)
      .filter((one) => one !== null && !closedApprovalsRef.current.has(one.id))
      .map((one) => ({
        id: one.id,
        kind: one.kind,
        askedBy: one.askedBy,
        // An 'agent_action''s texts, whole (lib/approvalKinds.js); null otherwise
        question: one.question,
        primaryLabel: one.primaryLabel,
        body: one.body,
        request: one.request,
        askerVerified: one.askerVerified,
        channel: one.channel,
        expiresAt: now + approvalTimeLeft(one, { now, fetched, serverNow }),
        serverExpiresAt: one.expiresAt,
      }))
      .filter((one) => one.expiresAt > now);
    if (fresh.length === 0) return;
    setApprovals((prev) => {
      const next = [...prev];
      fresh.forEach((one) => {
        if (next.length < MAX_APPROVALS && !next.some((held) => held.id === one.id)) next.push(one);
      });
      // They all wait equally long, so the one the server closes first was asked first
      return next.length === prev.length ? prev : next.sort((a, b) => a.serverExpiresAt - b.serverExpiresAt);
    });
  }, []);

  /** An approval ended (answered here or elsewhere, or it ran out): it leaves the line. */
  const closeApproval = useCallback((id, outcome) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return;
    const closed = closedApprovalsRef.current;
    closed.delete(id);
    if (closed.size >= MAX_CLOSED_REMEMBERED) closed.delete(closed.keys().next().value);
    closed.set(id, outcome);
    setApprovals((prev) => (prev.some((one) => one.id === id) ? prev.filter((one) => one.id !== id) : prev));
    // This person's own request: how it ended
    const mine = notesRequestRef.current;
    if (mine && mine.status === 'asked' && mine.id === id && NOTES_OUTCOMES[outcome]) {
      putNotesRequest({ status: NOTES_OUTCOMES[outcome] });
      // Agreed: the notes are shared now. The state says so; read it in case
      // the socket's word was missed
      if (outcome === 'approved' && stateRef.current.notesShared !== true) refreshState();
    }
  }, [putNotesRequest, refreshState]);

  // What Arlo was asked and did, put with what is held. A private action is
  // for its owner alone: a panel that is not an owner's does not keep one.
  const addActions = useCallback((values) => {
    const asOwner = stateRef.current.role === 'owner' && signedInRef.current;
    const fresh = (Array.isArray(values) ? values : []).map(parseAction)
      .filter((one) => one !== null && (one.public || asOwner));
    if (fresh.length > 0) setActions((prev) => mergeActions(prev, fresh));
  }, []);

  // Something for this panel to do with the Zoom Apps SDK, once: only an
  // owner's panel does, and not after the meeting is over. How it went is
  // reported to the server; nothing of it is logged or kept.
  const runAction = useCallback((data) => {
    if (stateRef.current.role !== 'owner' || !signedInRef.current || endedRef.current) return;
    const id = serverMeetingIdRef.current;
    const { actionId } = data;
    if (!id || typeof actionId !== 'string' || !UUID.test(actionId)) return;
    const ran = ranActionsRef.current;
    if (ran.has(actionId)) return;
    if (ran.size >= MAX_ACTIONS_REMEMBERED) ran.delete(ran.values().next().value);
    ran.add(actionId);
    // Asked again before Zoom acts on something that took time to prepare
    const stillAllowed = () => stateRef.current.role === 'owner' && signedInRef.current && !endedRef.current
      && serverMeetingIdRef.current === id;
    // The result, until the server has it: without it the server records a
    // failure although Zoom acted, and asking again would act twice. The same
    // result is sent each time (the server takes a repeat); Zoom is not asked again.
    const report = async (body, attempt) => {
      let again = false;
      try {
        const res = await fetch(arloUrl(id, `actions/${encodeURIComponent(actionId)}/result`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body,
        });
        again = reportAgainAfter(res.status);
      } catch {
        again = true;
      }
      // Given up: the server stops waiting by itself
      if (!again || attempt >= RESULT_RETRY_MS.length) return;
      const timers = resultTimersRef.current;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stillAllowed()) report(body, attempt + 1);
      }, RESULT_RETRY_MS[attempt]);
      timers.add(timer);
    };
    runArloAction(zoomSdkRef.current, { tool: data.tool, args: data.args }, { zoomRole: zoomRoleRef.current, stillAllowed })
      .then((result) => report(JSON.stringify(result.ok === true ? { ok: true } : { ok: false, code: result.code }), 0));
  }, []);

  // A panel that goes away reports nothing more
  useEffect(() => {
    const timers = resultTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // The state, once the server lets this panel ask. Again when the socket is
  // replaced (a reconnect) and when who is signed in changes (their role can change).
  useEffect(() => {
    if (!serverMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'state'), { credentials: 'include' })
      .then((res) => {
        if (!cancelled && REFUSED.has(res.status)) dropRefusedNotes();
        return res.ok ? res.json() : null;
      })
      .then((data) => { if (!cancelled && data) applyState(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverMeetingId, accessVerified, identity, ws, applyState, dropRefusedNotes]);

  useEffect(() => {
    if (!ws || !serverMeetingId) return undefined;
    const onMessage = (event) => {
      const message = readMeetingMessage(event, serverMeetingId);
      if (!message) return;
      const data = message.data;
      // The server speaks about this meeting on this socket: it is subscribed
      setLiveSocket(ws);
      switch (message.type) {
        case 'meeting.status':
          // Set here too, so the `arlo.state` that follows in the same turn is read correctly
          if (data.status === 'rtms_stopped' && data.meetingEnded === true) endedRef.current = true;
          else if (data.status === 'rtms_started') {
            endedRef.current = false;
            // The server sends `arlo.state` right after this: until then the role may be stale
            setAwaitingState(true);
          }
          break;
        case 'arlo.state':
          // Arlo is in the meeting, so it has not ended: covers a missed "started"
          if (data.present === true) endedRef.current = false;
          setAwaitingState(false);
          applyState(data);
          break;
        case 'notes.updated':
          applyNotes(data.notes);
          break;
        case 'arlo.approval':
          addApprovals([data]);
          break;
        case 'arlo.approval.closed':
          closeApproval(data.id, typeof data.outcome === 'string' ? data.outcome : null);
          break;
        case 'arlo.action':
          runAction(data);
          break;
        case 'arlo.did':
          addActions([data.action]);
          break;
        case 'arlo.thinking':
          // For owners; anything but `true` is "off"
          if (data.on === true && stateRef.current.role === 'owner' && signedInRef.current && !endedRef.current) {
            setThinkingNow({ step: readThinkingStep(data.step), channel: readThinkingChannel(data.channel) });
          } else if (data.on === false) {
            setThinkingNow(null);
          }
          break;
        default:
          break;
      }
    };
    ws.addEventListener('message', onMessage);
    return () => {
      ws.removeEventListener('message', onMessage);
      setAwaitingState(false);
    };
  }, [ws, serverMeetingId, applyState, applyNotes, addApprovals, closeApproval, runAction, addActions]);

  // What Arlo did so far, once the server lets this panel ask and its state is
  // known. Again when the role changes (an owner gets their private ones),
  // when who is signed in changes, and when the socket is replaced.
  const stateLoaded = state.loaded;
  useEffect(() => {
    if (!serverMeetingId || !accessVerified || !stateLoaded || meetingOver) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'actions'), { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) addActions(data.actions); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverMeetingId, accessVerified, stateLoaded, state.role, identity, ws, meetingOver, addActions]);

  // No longer an owner (or no longer signed in): the private ones go
  const keepsPrivate = state.role === 'owner' && isAuthenticated;
  useEffect(() => {
    if (keepsPrivate) return;
    setActions((prev) => (prev.some((one) => !one.public) ? prev.filter((one) => one.public) : prev));
  }, [keepsPrivate]);

  // "Thinking" without an "off" ends by itself; a socket that is replaced may
  // have missed the "off"
  useEffect(() => {
    if (thinkingNow === null) return undefined;
    const timer = setTimeout(() => setThinkingNow(null), THINKING_MS);
    return () => clearTimeout(timer);
  }, [thinkingNow]);
  useEffect(() => () => setThinkingNow(null), [ws]);

  // What this panel can do for Arlo, said to the server on a subscribed socket:
  // by an owner, and again when the Zoom role or the abilities change. Someone
  // who announced and is no longer an owner (or whose meeting is over) clears it.
  const hands = useMemo(
    () => handsFor({ chatSupported, waitingRoomSupported, zoomRole }),
    [chatSupported, waitingRoomSupported, zoomRole],
  );
  const hasHands = state.role === 'owner' && isAuthenticated && !meetingOver;
  useEffect(() => {
    if (!ws || liveSocket !== ws || ws.readyState !== SOCKET_OPEN) return;
    const sent = handsSentRef.current.socket === ws ? handsSentRef.current.json : null;
    if (!hasHands && sent === null) return;
    const payload = { zoomRole, can: hasHands ? hands : [] };
    const json = JSON.stringify(payload);
    if (json === sent) return;
    try {
      ws.send(JSON.stringify({ type: 'arlo.hands', payload }));
      handsSentRef.current = { socket: ws, json };
    } catch {
      // A socket that closed meanwhile: its replacement is told
    }
  }, [ws, liveSocket, hasHands, hands, zoomRole]);

  // Becoming someone who may see the notes (an owner, or anyone once they are
  // shared) fetches them; no longer being one clears them
  const role = state.role;
  const notesShared = state.notesShared === true;
  const canHoldNotes = mayHoldNotes(state);
  useEffect(() => {
    if (!canHoldNotes) {
      setNotes(null);
      return undefined;
    }
    if (!serverMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'notes'), { credentials: 'include' })
      .then((res) => {
        if (!cancelled && REFUSED.has(res.status)) dropRefusedNotes();
        return res.ok ? res.json() : null;
      })
      .then((data) => { if (!cancelled && data) applyNotes(data.notes); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNotesAnswered(true); });
    return () => { cancelled = true; };
  }, [canHoldNotes, serverMeetingId, accessVerified, applyNotes, dropRefusedNotes]);

  // The notes are shared: a request for them has nothing left to say
  useEffect(() => {
    if (notesShared && notesRequestRef.current !== null) putNotesRequest(null);
  }, [notesShared, notesRequest, putNotesRequest]);

  // Becoming an owner reads the requests that are waiting (a panel that
  // reloads, or a socket that was away); no longer being one drops them
  useEffect(() => {
    if (role !== 'owner') {
      setApprovals([]);
      return undefined;
    }
    if (!serverMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'approvals'), { credentials: 'include' })
      .then(async (res) => (res.ok ? { data: await res.json(), serverNow: serverClock(res) } : null))
      .then((answer) => {
        if (!cancelled && answer?.data) addApprovals(answer.data.approvals, { fetched: true, serverNow: answer.serverNow });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [role, serverMeetingId, accessVerified, ws, addApprovals]);

  // An approval past its time leaves the line by itself, whatever the socket says
  useEffect(() => {
    if (approvals.length === 0) return undefined;
    const soonest = Math.min(...approvals.map((one) => one.expiresAt));
    const timer = setTimeout(() => {
      setApprovals((prev) => prev.filter((one) => one.expiresAt > Date.now()));
    }, Math.max(0, soonest - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [approvals]);

  // A request for the notes that ended makes room for the next one after a
  // while; one that is waiting runs out here too if the server's word is missed
  useEffect(() => {
    if (!notesRequest || notesRequest.retry) return undefined;
    const asked = notesRequest.status === 'asked';
    const wait = asked ? Math.max(0, notesRequest.expiresAt - Date.now()) + NOTES_REQUEST_LATE_MS : ASK_NOTES_AGAIN_MS;
    const timer = setTimeout(() => putNotesRequest(asked ? { status: 'expired' } : null), wait);
    return () => clearTimeout(timer);
  }, [notesRequest, putNotesRequest]);

  // The server has no name for the owner, and this person is one: their Zoom
  // screen name is offered, once per meeting. A nicety: the answer is not read
  // (the server tells every panel over the socket) and a failure is silent.
  const screenName = usableName(userContext?.screenName, MAX_SUPPLIED_NAME_CHARS);
  const nameless = state.loaded && state.ownerName === null;
  const nameSentForRef = useRef(null);
  useEffect(() => {
    if (role !== 'owner' || !nameless || !screenName || !serverMeetingId || !accessVerified) return;
    if (nameSentForRef.current === serverMeetingId) return;
    nameSentForRef.current = serverMeetingId;
    fetch(arloUrl(serverMeetingId, 'settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ displayName: screenName }),
    }).catch(() => {});
  }, [role, nameless, screenName, serverMeetingId, accessVerified]);

  // A measurement: the owner's panel tells the server who Zoom says they are
  // in this meeting, once per meeting for each person who signs in on this
  // panel, so the server can count how often a transcript line's speaker
  // equals that. The answer is not read and a failure is silent.
  const identityJson = useMemo(() => {
    const report = identityReport(userContext);
    return report ? JSON.stringify(report) : null;
  }, [userContext]);
  const identitySentForRef = useRef(new Set());
  useEffect(() => {
    if (role !== 'owner' || identity === null || !identityJson || !serverMeetingId || !accessVerified) return;
    // By meeting and person: neither can hold the separator
    const sentFor = JSON.stringify([serverMeetingId, identity]);
    if (identitySentForRef.current.has(sentFor)) return;
    identitySentForRef.current.add(sentFor);
    fetch(arloUrl(serverMeetingId, 'identity'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: identityJson,
    }).catch(() => {});
  }, [role, identity, identityJson, serverMeetingId, accessVerified]);

  const setWhoCanAsk = useCallback(async (value) => {
    const id = serverMeetingIdRef.current;
    if (!id || !WHO_CAN_ASK.has(value)) return false;
    try {
      const res = await fetch(arloUrl(id, 'settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ whoCanAsk: value }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (serverMeetingIdRef.current === id) applyState(data);
      return true;
    } catch {
      return false;
    }
  }, [applyState]);

  /**
   * The owner shares the notes with everyone in the meeting who has Arlo open
   * (true), or stops (false). Resolves true when the server took it; the
   * caller says so when it did not.
   */
  const setShareNotes = useCallback(async (value) => {
    const id = serverMeetingIdRef.current;
    if (!id || typeof value !== 'boolean') return false;
    try {
      const res = await fetch(arloUrl(id, 'settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shareNotes: value }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (serverMeetingIdRef.current === id) applyState(data);
      return true;
    } catch {
      return false;
    }
  }, [applyState]);

  const ask = useCallback(async (question) => {
    const text = typeof question === 'string' ? question.trim() : '';
    if (text.length === 0) return { error: ASK_MESSAGES.empty };
    if (text.length > MAX_QUESTION_CHARS) return { error: ASK_MESSAGES.tooLong };
    const id = serverMeetingIdRef.current;
    if (!id) return { error: ASK_MESSAGES.noMeeting };
    if (askingRef.current) return { error: ASK_MESSAGES.busy };
    askingRef.current = true;
    setAsking(true);
    try {
      const res = await fetch(arloUrl(id, 'ask'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ question: text }),
      });
      // The server's own error text is not shown: short, known messages only
      if (!res.ok) return { error: ASK_MESSAGES[res.status] || ASK_MESSAGES.failed };
      const data = await res.json().catch(() => null);
      if (typeof data?.answer !== 'string' || data.answer.trim().length === 0) {
        return { error: ASK_MESSAGES.failed };
      }
      const answer = data.answer.trim().slice(0, MAX_ANSWER_CHARS);
      // The request was something to do: how it stands
      const { id: actionId, tool, status } = data.action ?? {};
      const known = typeof actionId === 'string' && actionId.length > 0 && actionId.length <= MAX_ACTION_ID_CHARS
        && typeof tool === 'string' && tool.length > 0 && tool.length <= MAX_TOOL_CHARS
        && ASK_ACTION_STATUSES.has(status);
      return known ? { answer, action: { id: actionId, tool, status } } : { answer };
    } catch {
      return { error: ASK_MESSAGES.failed };
    } finally {
      askingRef.current = false;
      setAsking(false);
    }
  }, []);

  /**
   * The owner's answer: { approve: true | false }. Agreeing is all the panel
   * does: the server does what was asked (it shares the notes, or runs what
   * Arlo was asked to do). Only `approve` is sent, whatever else is passed.
   * Resolves how it went: 'taken' (the server has the answer and, for an
   * agreement, did it), 'failed' (it has the answer and could not do it) or
   * 'unsent' (the answer did not reach it, or it refused it). Either way the
   * request leaves this panel's line: it is answered, or no longer open.
   */
  const answerApproval = useCallback(async (approvalId, answer) => {
    const id = serverMeetingIdRef.current;
    if (!id || typeof approvalId !== 'string' || typeof answer?.approve !== 'boolean') return 'unsent';
    const body = { approve: answer.approve };
    let went = 'unsent';
    try {
      const res = await fetch(arloUrl(id, `approvals/${encodeURIComponent(approvalId)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      // 'failed': the owner agreed and the server could not do it
      if (res.ok) went = data?.outcome === 'failed' ? 'failed' : 'taken';
    } catch {
      // The server lets it run out
    }
    if (serverMeetingIdRef.current === id) closeApproval(approvalId, null);
    return went;
  }, [closeApproval]);

  /** A participant asks the owners to share the notes with everyone in the meeting. */
  const requestNotes = useCallback(async () => {
    const id = serverMeetingIdRef.current;
    if (!id || requestingNotesRef.current) return;
    const held = notesRequestRef.current;
    if (held && !held.retry) return;
    requestingNotesRef.current = true;
    setRequestingNotes(true);
    let next;
    try {
      const res = await fetch(arloUrl(id, 'notes-request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (res.ok && typeof data?.id === 'string' && data.id.length > 0 && data.id.length <= 64) {
        const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : Date.now() + 60000;
        // Answered before this response arrived
        const already = NOTES_OUTCOMES[closedApprovalsRef.current.get(data.id)];
        next = already ? { status: already } : { status: 'asked', id: data.id, expiresAt };
      } else if (res.status === 429) {
        // The server knows why (asked a moment ago, or too many requests are
        // waiting): its words when they are short text, else this panel's
        const said = shortServerMessage(await res.json().catch(() => null));
        next = { status: 'error', message: said ?? NOTES_REQUEST_MESSAGES[429] };
      } else if (res.status === 409 && (await res.json().catch(() => null))?.error === 'already_shared') {
        // Nothing to ask for and nothing to say: the notes show once the state is read
        next = null;
        refreshState();
      } else {
        next = { status: 'error', message: NOTES_REQUEST_MESSAGES[res.status] || NOTES_REQUEST_MESSAGES.failed, retry: true };
      }
    } catch {
      next = { status: 'error', message: NOTES_REQUEST_MESSAGES.failed, retry: true };
    } finally {
      requestingNotesRef.current = false;
      setRequestingNotes(false);
    }
    if (serverMeetingIdRef.current === id) putNotesRequest(next);
  }, [putNotesRequest, refreshState]);

  // Held only by someone who may see them; said here too, so the render between
  // sharing being stopped and the notes being dropped shows none
  const holdsNotes = canHoldNotes && notes !== null;
  useEffect(() => {
    setRecordRetained(holdsNotes);
  }, [holdsNotes, setRecordRetained]);

  // Out of the meeting, what Arlo did stays only with notes that are held: the
  // meeting record is kept on the same rule (MeetingContext `setRecordRetained`)
  useEffect(() => {
    if (meetingId || holdsNotes) return;
    setActions((prev) => (prev.length > 0 ? NO_ACTIONS : prev));
  }, [meetingId, holdsNotes]);

  // Only an owner is told, and not about a meeting that is over
  const thinking = thinkingNow !== null && role === 'owner' && isAuthenticated && !meetingOver && !switchingMeeting;
  useEffect(() => {
    setArloThinking(thinking);
  }, [thinking, setArloThinking]);
  const thinkingStep = thinking ? thinkingNow.step : null;
  const thinkingChannel = thinking ? thinkingNow.channel : null;
  const shownActions = switchingMeeting ? NO_ACTIONS : actions;

  // The render between Zoom reporting another meeting and the reset above
  // already shows nothing of the previous one
  const shown = switchingMeeting ? NOT_LOADED : state;
  const shownNotes = switchingMeeting || !canHoldNotes ? null : notes;
  // Only an owner is asked, and not about a meeting that is over
  const shownApprovals = useMemo(
    () => (switchingMeeting || role !== 'owner' || meetingOver ? [] : approvals),
    [switchingMeeting, role, meetingOver, approvals],
  );
  const shownNotesRequest = switchingMeeting ? null : notesRequest;
  // The meeting whose notes are still on screen after it is over, for the way
  // back to them. For a signed-in person: the way back is a signed-in route.
  const afterNotesMeetingId = !switchingMeeting && holdsNotes && meetingOver && identity !== null ? lastMeetingId : null;
  // An owner whose notes are on their way: not yet "an owner without notes"
  const notesPending = role === 'owner' && notes === null && !notesAnswered
    && Boolean(serverMeetingId) && accessVerified && !switchingMeeting;

  const value = useMemo(() => ({
    loaded: shown.loaded,
    present: shown.present,
    paused: shown.paused,
    myStreamPaused: shown.myStreamPaused,
    myStreamLive: shown.myStreamLive,
    role: shown.role,
    ownerName: shown.ownerName,
    whoCanAsk: shown.whoCanAsk,
    notesShared: shown.notesShared,
    everPresent: everPresent && !switchingMeeting,
    notes: shownNotes,
    notesPending,
    awaitingState,
    meetingOver: meetingOver && !switchingMeeting,
    afterNotesMeetingId,
    setWhoCanAsk,
    setShareNotes,
    ask,
    asking,
    approvals: shownApprovals,
    answerApproval,
    notesRequest: shownNotesRequest,
    requestNotes,
    requestingNotes,
    actions: shownActions,
    thinking,
    thinkingStep,
    thinkingChannel,
  }), [shownActions, thinking, thinkingStep, thinkingChannel, shown, everPresent, switchingMeeting, shownNotes, notesPending, awaitingState, meetingOver, afterNotesMeetingId, setWhoCanAsk, setShareNotes, ask, asking,
    shownApprovals, answerApproval, shownNotesRequest, requestNotes, requestingNotes]);

  return (
    <ArloContext.Provider value={value}>
      {children}
    </ArloContext.Provider>
  );
}

export function useArlo() {
  const context = useContext(ArloContext);
  if (!context) {
    throw new Error('useArlo must be used within an ArloProvider');
  }
  return context;
}
