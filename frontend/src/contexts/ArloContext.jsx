import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useMeeting } from './MeetingContext';
import { useAuth } from './AuthContext';
import { cleanNotes } from '../lib/notesText';
import { readMeetingMessage } from '../lib/meetingMessage';

/**
 * What this panel knows about Arlo in the current meeting: is it here, what is
 * this person to it (owner or participant), the owner's live notes, and the
 * private "ask". The server decides all of it; this only holds what it said.
 *
 * - State comes from GET …/arlo/state once meeting access is verified, and
 *   from `arlo.state` on the meeting socket afterwards.
 * - Notes come from GET …/arlo/notes and `notes.updated`, for owners only.
 * - A message for another meeting id is ignored (an owner's socket can be
 *   told about another meeting).
 * - Routes and messages go by the meeting id the server verified
 *   (`verifiedMeetingId`), not the one read from the Zoom SDK: the two can
 *   differ. The SDK's id only says when the panel moved to another meeting.
 * - When the meeting ends the server deletes its data and says so: role
 *   'participant', no owner. The panel keeps what it had, so the owner's notes
 *   stay on screen until another meeting is opened.
 * - Leaving the meeting is the same for this panel as the meeting ending
 *   (`meetingOver`): the server's word may never arrive, the socket is closed.
 * - While the owner's notes are held, the meeting's transcript and timeline are
 *   held with them (MeetingContext), so the meeting record still opens.
 *
 * - `paused` is about the meeting (true only when every live stream in it is
 *   paused); `myStreamPaused` is about this person's own stream. Several people
 *   can each run a stream in one meeting.
 * - What is held belongs to the signed-in person: when they stop being signed
 *   in (sign-out, session loss, deauthorization) or someone else is signed in,
 *   the state, the notes and the way back to them are dropped. An owner is
 *   always signed in: without a session the role is never 'owner'.
 *
 * Nothing here is logged: state, notes, questions and answers are meeting content.
 */
const ArloContext = createContext();

const ROLES = new Set(['owner', 'participant']);
const WHO_CAN_ASK = new Set(['owner', 'anyone']);
const MAX_QUESTION_CHARS = 500;
const MAX_NAME_CHARS = 200;
const MAX_ANSWER_CHARS = 4000;
// After a stream started: how long to wait for the server to say whose it is
const STATE_AFTER_START_MS = 3000;

// `present` and `role` are null until the server answered: "not known" is not "not here"
const NOT_LOADED = Object.freeze({
  loaded: false, present: null, paused: false, myStreamPaused: false, role: null, ownerName: null, whoCanAsk: 'owner',
});

const ASK_MESSAGES = {
  empty: 'Type a question first.',
  tooLong: `Keep the question under ${MAX_QUESTION_CHARS} characters.`,
  busy: 'Arlo is still answering.',
  noMeeting: 'Open Arlo in a meeting to ask.',
  401: 'Sign in to ask Arlo.',
  403: 'You can\'t ask Arlo in this meeting.',
  409: 'Nothing has been said since Arlo joined.',
  429: 'Arlo is busy right now. Try again in a minute.',
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
    role: data.role,
    ownerName: typeof data.ownerName === 'string' && data.ownerName.length > 0
      ? data.ownerName.slice(0, MAX_NAME_CHARS)
      : null,
    whoCanAsk: WHO_CAN_ASK.has(data.whoCanAsk) ? data.whoCanAsk : 'owner',
  };
}

const arloUrl = (meetingId, name) => `/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${name}`;

export function ArloProvider({ children }) {
  const {
    ws, meetingId, verifiedMeetingId, meetingAccess, meetingEnded, leftMeeting, lastMeetingId, switchingMeeting,
    setRecordRetained,
  } = useMeeting();
  // The id for everything asked of the server and accepted from it; none before
  // access is verified or out of the meeting
  const serverMeetingId = meetingId ? verifiedMeetingId : null;
  // Over for this panel: Zoom said the meeting ended, or this person left it
  const meetingOver = meetingEnded === true || leftMeeting === true;
  const { isAuthenticated, user } = useAuth();
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

  // Read by the socket handler, which must not wait for a render
  const stateRef = useRef(NOT_LOADED);
  const endedRef = useRef(false);
  const askingRef = useRef(false);
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
  }, [meetingId]);

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
  }, [identity]);

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
      : { ...parsed, role: 'participant', myStreamPaused: false };
    const prev = stateRef.current;
    // After the meeting ended the server has nothing left to say about it:
    // Arlo is gone, and who this person was to it stays as it was.
    const merged = endedRef.current && prev.loaded
      ? { ...prev, present: false, paused: false, myStreamPaused: false }
      : { loaded: true, ...next };
    stateRef.current = merged;
    setState(merged);
    if (merged.present) setEverPresent(true);
  }, []);

  // Newer notes win; notes for someone who is not an owner are not kept
  const applyNotes = useCallback((value) => {
    const clean = cleanNotes(value);
    if (!clean || stateRef.current.role !== 'owner' || !signedInRef.current) return;
    setNotes((prev) => (
      prev && prev.throughSeqNo !== null && clean.throughSeqNo !== null && prev.throughSeqNo > clean.throughSeqNo
        ? prev
        : clean
    ));
  }, []);

  // The state, once the server lets this panel ask. Again when the socket is
  // replaced (a reconnect) and when who is signed in changes (their role can change).
  useEffect(() => {
    if (!serverMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'state'), { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) applyState(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverMeetingId, accessVerified, identity, ws, applyState]);

  useEffect(() => {
    if (!ws || !serverMeetingId) return undefined;
    const onMessage = (event) => {
      const message = readMeetingMessage(event, serverMeetingId);
      if (!message) return;
      const data = message.data;
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
        default:
          break;
      }
    };
    ws.addEventListener('message', onMessage);
    return () => {
      ws.removeEventListener('message', onMessage);
      setAwaitingState(false);
    };
  }, [ws, serverMeetingId, applyState, applyNotes]);

  // Becoming an owner fetches the notes; no longer being one clears them
  const role = state.role;
  useEffect(() => {
    if (role !== 'owner') {
      setNotes(null);
      return undefined;
    }
    if (!serverMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    fetch(arloUrl(serverMeetingId, 'notes'), { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) applyNotes(data.notes); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNotesAnswered(true); });
    return () => { cancelled = true; };
  }, [role, serverMeetingId, accessVerified, applyNotes]);

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
      return { answer: data.answer.trim().slice(0, MAX_ANSWER_CHARS) };
    } catch {
      return { error: ASK_MESSAGES.failed };
    } finally {
      askingRef.current = false;
      setAsking(false);
    }
  }, []);

  const holdsNotes = role === 'owner' && notes !== null;
  useEffect(() => {
    setRecordRetained(holdsNotes);
  }, [holdsNotes, setRecordRetained]);

  // The render between Zoom reporting another meeting and the reset above
  // already shows nothing of the previous one
  const shown = switchingMeeting ? NOT_LOADED : state;
  const shownNotes = switchingMeeting ? null : notes;
  // The meeting whose notes are still on screen after it is over, for the way back to them
  const afterNotesMeetingId = !switchingMeeting && holdsNotes && meetingOver ? lastMeetingId : null;
  // An owner whose notes are on their way: not yet "an owner without notes"
  const notesPending = role === 'owner' && notes === null && !notesAnswered
    && Boolean(serverMeetingId) && accessVerified && !switchingMeeting;

  const value = useMemo(() => ({
    loaded: shown.loaded,
    present: shown.present,
    paused: shown.paused,
    myStreamPaused: shown.myStreamPaused,
    role: shown.role,
    ownerName: shown.ownerName,
    whoCanAsk: shown.whoCanAsk,
    everPresent: everPresent && !switchingMeeting,
    notes: shownNotes,
    notesPending,
    awaitingState,
    meetingOver: meetingOver && !switchingMeeting,
    afterNotesMeetingId,
    setWhoCanAsk,
    ask,
    asking,
  }), [shown, everPresent, switchingMeeting, shownNotes, notesPending, awaitingState, meetingOver, afterNotesMeetingId, setWhoCanAsk, ask, asking]);

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
