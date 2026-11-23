import React, { createContext, useContext, useState, useReducer, useRef, useCallback, useEffect, useMemo } from 'react';
import { useZoomSdk } from './ZoomSdkContext';
import { useAuth } from './AuthContext';
import { useServerSettings } from './ServerSettingsContext';
import {
  initialRtmsState,
  rtmsReducer,
  isRtmsActive,
  isRtmsPaused,
  isRtmsBusy,
  statusFromWs,
  statusFromRtmsStatusList,
  statusFromPoll,
  shouldAutoRestart,
  shouldRestartAfterFault,
  STREAM_FAULT,
  canStartRtms,
} from '../lib/rtmsMachine';
import { addSegment, mergeHistory } from '../lib/transcript';
import { readMeetingMessage } from '../lib/meetingMessage';
import { indicatorText } from '../lib/dynamicIndicator';
import { useDynamicIndicator } from '../hooks/useDynamicIndicator';

const MeetingContext = createContext();

// A start that isn't confirmed quickly is waiting on the host: say so after
// START_CONFIRM_TIMEOUT_MS. Zoom cancels an unanswered request after 60 seconds;
// the client is not told, so the request expires here on the same clock.
const START_CONFIRM_TIMEOUT_MS = 5000;
const START_REQUEST_EXPIRY_MS = 60000;
// Zoom's client says "started" but the server has seen no stream: how long to
// show "Starting transcription…" before giving the Start button back.
const STREAM_ARRIVAL_TIMEOUT_MS = 15000;
// ...and how long before Arlo asks Zoom to start again by itself (once).
const AUTO_RESTART_DELAY_MS = 6000;
// After a stream fault: a short pause before asking Zoom for a new stream
const FAULT_RESTART_DELAY_MS = 2000;
const START_OPTIONS = {
  audioOptions: { rawAudio: false },
  transcriptOptions: { caption: true },
};
// The client sends no event when the host denies a request or allows the app
// later, so while a start is unresolved Arlo asks the client itself.
const STATUS_POLL_INTERVAL_MS = 5000;
const STATUS_POLL_PHASES = new Set(['requested', 'expired', 'denied', 'failed', 'stalled']);

const readRtmsStatus = (sdk) => (typeof sdk.getRTMSStatus === 'function'
  ? sdk.getRTMSStatus()
  : sdk.callZoomApi('getRTMSStatus'));
const ACTION_CONFIRM_TIMEOUT_MS = 10000;

const NO_ACCESS = Object.freeze({
  status: 'idle', isGuest: null, reason: null, everVerified: false, transient: false,
});
const NOTHING = Object.freeze([]);

const DEFAULT_CHAT_NOTICES = {
  enabled: false,
  events: { start: true, pause: true, resume: true, stop: false, restart: false },
  messages: {
    start: "I'm using a Zoom app, Arlo, to transcribe this meeting and generate a summary.",
    pause: 'Transcription paused.',
    resume: 'Transcription resumed.',
    stop: 'Transcription stopped. Transcript will be available shortly.',
    restart: 'Transcription restarted.',
  },
};

export function MeetingProvider({ children }) {
  const {
    zoomSdk, meetingContext, isGuest, userContext, runningContext, rtmsStatusSupported, dynamicIndicatorSupported,
  } = useZoomSdk();
  const { demoMode, autoStartAvailable } = useServerSettings();
  const autoStartAvailableRef = useRef(autoStartAvailable);
  autoStartAvailableRef.current = autoStartAvailable;
  // Transcription state changes only on confirmed signals (see lib/rtmsMachine.js).
  const [rtms, dispatchRtms] = useReducer(rtmsReducer, initialRtmsState);
  const rtmsActive = isRtmsActive(rtms);
  const rtmsPaused = isRtmsPaused(rtms);
  const rtmsLoading = isRtmsBusy(rtms);
  const [ws, setWs] = useState(null);
  const [viewers, setViewers] = useState(null);
  // The live transcript and join/leave timeline live here, not in a view, so
  // they keep filling while the user is on another screen and survive navigation.
  const [segments, setSegments] = useState([]);
  const [participantEvents, setParticipantEvents] = useState([]);
  // Counts the server's "subscribed" confirmations; each one reloads history
  const [subscribedCount, setSubscribedCount] = useState(0);
  // Server-verified meeting access (Zoom App Context). status:
  // 'idle' | 'verifying' | 'verified' | 'denied' | 'unavailable'
  // everVerified: access was verified for this meeting before (a re-check on a
  // reconnect keeps the screen, see lib/meetingAccess.js). transient: the
  // check got no verdict (network, 5xx, 429) and is tried again.
  const [meetingAccess, setMeetingAccess] = useState(NO_ACCESS);
  // The meeting id the server verified for this panel: the one inside the
  // `meetingAccess` token, returned by POST /api/auth/meeting-access. The
  // server stamps every socket message with it and serves the meeting's routes
  // under it. It is normally equal to the id read from the Zoom SDK
  // (`meetingId` below), but that one has fallbacks (down to the numeric
  // meeting id) and the two are never compared by the server. So everything
  // asked of the server and everything accepted from it goes by this id; the
  // SDK's id only says which meeting the panel is in (and is in the address).
  // null until access is verified, and again once the meeting is left.
  //
  // It is held with the meeting the panel was in when it was verified
  // (`forMeeting`, the SDK's id; null when the SDK had not reported one yet,
  // which the first id reported then fills in). In any other meeting it reads
  // as null from the very render in which the SDK's id changes: nothing can be
  // asked of the server, or accepted from it, under the previous meeting's id.
  const [verified, setVerified] = useState(null); // { id, forMeeting } | null
  const verifiedRef = useRef(null);
  const applyVerifiedMeetingId = useCallback((id, forMeeting = null) => {
    const next = id ? { id, forMeeting: forMeeting || null } : null;
    verifiedRef.current = next;
    setVerified(next);
  }, []);
  // The SDK id / server id pair already reported as different (reported once)
  const reportedMismatchRef = useRef(null);

  // Zoom reported that the meeting itself ended (not just the stream). Kept
  // until another meeting is opened, so the after-meeting screen can stay.
  const [meetingEnded, setMeetingEnded] = useState(false);
  const lastMeetingIdRef = useRef(null);
  // The meeting this panel's transcript, timeline and state belong to. Leaving
  // the meeting (no id) keeps it; only another meeting replaces it.
  const [lastMeetingId, setLastMeetingId] = useState(null);
  // The owner's notes are held (ArloContext): the transcript and timeline are
  // kept with them after the meeting, so the meeting record still opens.
  const [recordRetained, setRecordRetained] = useState(false);

  const meetingStartTimeRef = useRef(null);
  const autoStartAttemptedRef = useRef(false);
  const titleSentRef = useRef(false);
  const hasBeenActiveRef = useRef(false);
  const statusCheckRef = useRef(false);
  const titleUserRenamedRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const startNoticeSentRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const connectingRef = useRef(false);
  const zoomSdkRef = useRef(zoomSdk);
  zoomSdkRef.current = zoomSdk;
  const rtmsRef = useRef(rtms);
  rtmsRef.current = rtms;
  // When the pending start request expires (ms epoch), for the countdown in the UI
  const [rtmsRequestExpiresAt, setRtmsRequestExpiresAt] = useState(null);
  // Counts start requests so a repeated request restarts the 60s countdown
  const [startAttempt, setStartAttempt] = useState(0);
  // The request this client made and is waiting on. Chat notices and timeline
  // events fire when Zoom confirms it, and only on the client that asked.
  const localActionRef = useRef(null);
  const startedHereRef = useRef(false);
  const alreadyRunningRef = useRef(false);
  const autoRestartedRef = useRef(false);
  // Stream faults: whether the stream that just stopped was started here (and
  // not stopped here), and how many automatic restarts this meeting has had.
  // Dynamic Indicator inputs: is the confirmed stream one this client started,
  // and what the meeting screen reports about voice commands.
  const [streamStartedHere, setStreamStartedHere] = useState(false);
  // This panel asked Zoom for the stream (a click, or its own restart) and the
  // request has not ended. Known before the stream is confirmed.
  const [startAskedHere, setStartAskedHere] = useState(false);
  const [voiceState, setVoiceState] = useState({ enabled: false, processing: false });
  // What the server says about this person's own stream: paused (true), running
  // (false), or nothing (null: not an owner, Arlo not here, or not told yet).
  // From `arlo.state` on the socket. A pause made with Zoom's own controls is
  // only known this way.
  const ownPauseOnServerRef = useRef(null);
  // The same, as state, for what is rendered from it (Zoom's indicator)
  const [ownPauseOnServer, setOwnPauseOnServer] = useState(null);
  // The server says Arlo is in the meeting and no stream of this person's own
  // runs: it is here through someone else's. A start asked for then is this
  // person's own, beside that stream (see lib/rtmsMachine.js `alongside`).
  // From `arlo.state` on the socket; false until the server says so.
  const besideAnotherStreamRef = useRef(false);
  const stoppedStreamWasOursRef = useRef(false);
  const faultRestartsRef = useRef(0);
  const isGuestRef = useRef(isGuest);
  const userContextRef = useRef(userContext);
  isGuestRef.current = isGuest;
  userContextRef.current = userContext;

  const meetingId = meetingContext?.meetingUUID;
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;
  const verifiedFor = (held, sdkMeetingId) => (
    held && (held.forMeeting === null || held.forMeeting === sdkMeetingId) ? held.id : null
  );
  const verifiedMeetingId = verifiedFor(verified, meetingId);
  /** The verified id for the meeting the panel is in right now (for callbacks). */
  const readVerifiedMeetingId = useCallback(() => {
    const held = verifiedRef.current;
    return held && (held.forMeeting === null || held.forMeeting === meetingIdRef.current) ? held.id : null;
  }, []);

  if (rtmsActive) {
    hasBeenActiveRef.current = true;
    if (!meetingStartTimeRef.current) meetingStartTimeRef.current = Date.now();
  }

  // Clean up when meeting ends (meetingId becomes falsy) and prepare for new meetings
  useEffect(() => {
    if (meetingId) {
      const previousId = lastMeetingIdRef.current;
      if (previousId !== meetingId) {
        setMeetingEnded(false);
        if (previousId !== null) {
          // Another meeting: nothing of the previous one may show in it
          dispatchRtms({ type: 'RESET' });
          setSegments([]);
          setParticipantEvents([]);
          setViewers(null);
          setMeetingAccess(NO_ACCESS);
          applyVerifiedMeetingId(null);
          // A reconnect that was waiting belongs to the previous meeting
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setWs((prev) => {
            if (prev && prev.readyState !== WebSocket.CLOSED) {
              prev.onclose = null;
              prev.close();
            }
            return null;
          });
        } else if (verifiedRef.current && verifiedRef.current.forMeeting === null) {
          // Verified before the SDK reported its meeting id: this is that meeting
          applyVerifiedMeetingId(verifiedRef.current.id, meetingId);
        }
      }
      lastMeetingIdRef.current = meetingId;
      setLastMeetingId(meetingId);
      // New meeting — allow WS reconnects and reset per-meeting refs
      shouldReconnectRef.current = true;
      autoStartAttemptedRef.current = false;
      titleSentRef.current = false;
      titleUserRenamedRef.current = false;
      hasBeenActiveRef.current = false;
      statusCheckRef.current = false;
      startNoticeSentRef.current = false;
      meetingStartTimeRef.current = null;
      localActionRef.current = null;
      startedHereRef.current = false;
      setStartAskedHere(false);
      alreadyRunningRef.current = false;
      autoRestartedRef.current = false;
      stoppedStreamWasOursRef.current = false;
      faultRestartsRef.current = 0;
    } else {
      // Meeting ended — stop reconnecting, close WS, reset state
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      dispatchRtms({ type: 'RESET' });
      setWs(prev => {
        if (prev && prev.readyState !== WebSocket.CLOSED) {
          prev.close();
        }
        return null;
      });
      // Out of the meeting, nothing more is asked of the server about it
      applyVerifiedMeetingId(null);
    }
  }, [meetingId, applyVerifiedMeetingId]);

  // Out of the meeting, its transcript and timeline are dropped, unless the
  // owner's notes are still on screen: then they go when the notes go.
  useEffect(() => {
    if (meetingId || recordRetained) return;
    setSegments((prev) => (prev.length > 0 ? [] : prev));
    setParticipantEvents((prev) => (prev.length > 0 ? [] : prev));
  }, [meetingId, recordRetained]);

  // Send a chat notice to Zoom meeting chat for a given event type
  const sendChatNotice = useCallback((eventType) => {
    if (!zoomSdk) return;
    try {
      const raw = localStorage.getItem('arlo-chat-notices');
      const prefs = raw ? JSON.parse(raw) : DEFAULT_CHAT_NOTICES;
      if (!prefs.enabled) return;
      if (!prefs.events?.[eventType]) return;
      const template = prefs.messages?.[eventType] || DEFAULT_CHAT_NOTICES.messages[eventType];
      if (!template) return;
      let message = meetingId
        ? template.replace(/\[meeting-id\]/g, meetingId)
        : template;
      // Append demo mode notice on start event
      if (demoMode && eventType === 'start') {
        message += '\n\nThe app is running in demo mode and won\'t retain data after this meeting.';
      }
      zoomSdk.sendMessageToChat({ message }).catch(() => {});
    } catch {
      // Silently ignore — chat notices are best-effort
    }
  }, [zoomSdk, meetingId, demoMode]);

  // Stable ref so detection paths (WS handler, REST fallback) can send chat notices
  const sendChatNoticeRef = useRef(sendChatNotice);
  useEffect(() => { sendChatNoticeRef.current = sendChatNotice; }, [sendChatNotice]);

  /**
   * Prove to the backend that this user has Arlo open in this meeting.
   * Sends the signed Zoom App Context; on success the backend sets an httpOnly
   * `meetingAccess` cookie that the WebSocket server requires. Works for
   * guests (no OAuth needed). Called before every (re)connect so the access
   * token never goes stale.
   */
  // true when the last access check got no verdict: the request failed to
  // reach the server, or the server answered 5xx / 429
  const accessCheckFailedToRunRef = useRef(false);
  /**
   * One access check. Answers 'verified', 'refused' or 'stale'.
   *
   * Every check remembers the meeting it was started for. When it answers and
   * the panel is in another meeting by then (or in none), the answer is about
   * a meeting the panel has left: it is 'stale' and dropped whole. No verified
   * id, no access state, and so no socket and no fetch for that meeting.
   */
  const checkMeetingAccess = useCallback(async () => {
    const sdk = zoomSdkRef.current;
    if (!sdk || typeof sdk.getAppContext !== 'function') {
      setMeetingAccess({ ...NO_ACCESS, status: 'unavailable', reason: 'Open Arlo inside a Zoom meeting to see the live transcript.' });
      return 'refused';
    }
    const startedFor = meetingIdRef.current || null;
    // Before the SDK reported a meeting id there is no meeting to have left
    const isStale = () => startedFor !== null && (meetingIdRef.current || null) !== startedFor;
    setMeetingAccess((prev) => ({ ...prev, status: 'verifying', reason: null, transient: false }));
    accessCheckFailedToRunRef.current = false;
    // A refusal: `transient` when it is not a verdict on this user (tried again)
    const refused = (reason) => {
      const transient = accessCheckFailedToRunRef.current;
      setMeetingAccess((prev) => ({
        ...NO_ACCESS, status: 'denied', reason, everVerified: prev.everVerified, transient,
      }));
    };
    const dropped = () => {
      accessCheckFailedToRunRef.current = false;
      // Out of any meeting nothing follows this check: it is no longer "verifying"
      if (!meetingIdRef.current) {
        setMeetingAccess((prev) => (prev.status === 'verifying' ? { ...NO_ACCESS, everVerified: prev.everVerified } : prev));
      }
      return 'stale';
    };
    try {
      const { context } = await sdk.getAppContext();
      let res;
      try {
        res = await fetch('/api/auth/meeting-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ appContext: context }),
        });
      } catch (networkError) {
        // No answer at all (network down): worth trying again
        accessCheckFailedToRunRef.current = true;
        throw networkError;
      }
      const data = await res.json().catch(() => ({}));
      if (isStale()) return dropped();
      // A gateway error or rate limit while the server restarts is not a
      // verdict on this user either. A 4xx refusal is, and is not retried.
      if (res.status >= 500 || res.status === 429) accessCheckFailedToRunRef.current = true;
      if (!res.ok) {
        refused(data.error || 'Could not verify your meeting.');
        return 'refused';
      }
      // The id the server verified. A server that does not name one (older
      // than this field) is followed by the id the SDK gave, as before.
      const sdkMeetingId = meetingIdRef.current || null;
      const serverMeetingId = typeof data.meetingId === 'string' && data.meetingId.length > 0
        ? data.meetingId
        : sdkMeetingId;
      if (sdkMeetingId && serverMeetingId !== sdkMeetingId) {
        const pair = `${sdkMeetingId}\n${serverMeetingId}`;
        if (reportedMismatchRef.current !== pair) {
          reportedMismatchRef.current = pair;
          // No ids: only that it happened, and whether the SDK fell back to the number
          console.warn(
            'The meeting id from the Zoom SDK differs from the one the server verified; using the server\'s.',
            { sdkIdIsNumeric: /^\d+$/.test(sdkMeetingId) },
          );
        }
      }
      applyVerifiedMeetingId(serverMeetingId, sdkMeetingId);
      setMeetingAccess({ ...NO_ACCESS, status: 'verified', isGuest: !!data.isGuest, everVerified: true });
      return 'verified';
    } catch (error) {
      if (isStale()) return dropped();
      console.error('Meeting access verification failed:', error);
      refused('Could not read your Zoom meeting context.');
      return 'refused';
    }
  }, [applyVerifiedMeetingId]);
  const verifyMeetingAccess = useCallback(async () => (await checkMeetingAccess()) === 'verified', [checkMeetingAccess]);

  // `meetingId` here is the server-verified id. The only caller is
  // connectWebSocket, after verifyMeetingAccess succeeded: no socket exists
  // before access is verified, so no message is applied before then either.
  const openSocket = useCallback((meetingId) => {
    // A new socket (another meeting, or a reconnect): the server says it again
    ownPauseOnServerRef.current = null;
    setOwnPauseOnServer(null);
    besideAnotherStreamRef.current = false;
    // A retry still waiting would replace the socket about to be opened
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close existing socket before creating new one
    setWs(prev => {
      if (prev && prev.readyState !== WebSocket.CLOSED) {
        // Deliberate replacement: detach so the old socket's onclose doesn't
        // schedule a reconnect that would in turn close this new socket.
        prev.onclose = null;
        prev.close();
      }
      return prev;
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = window.location.hostname;
    // No token in the URL: the browser sends the httpOnly cookies on the handshake.
    const wsUrl = `${protocol}//${hostname}/ws?meeting_id=${encodeURIComponent(meetingId)}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('WebSocket connected');
      const ctx = userContextRef.current;
      const participantName = ctx?.screenName || ctx?.firstName || null;
      socket.send(JSON.stringify({
        type: 'subscribe',
        payload: { meetingId, participantName, isGuest: !!isGuestRef.current },
      }));
    };

    socket.onmessage = (event) => {
      // Whether a message is for this panel is decided by one helper
      // (lib/meetingMessage.js), used by every socket listener. The server can
      // deliver another meeting's messages here (it registers an owner's
      // sockets under their other meeting too), so everything about a meeting
      // is dropped unless it names the meeting the server verified for this
      // socket (not the id the Zoom SDK reported: the two can differ).
      // Every message the server sends about a meeting carries data.meetingId
      // (backend/src/services/websocket.js): connected, subscribed,
      // unsubscribed, meeting.presence, meeting.status, transcript.segment,
      // participant.event, ai.suggestion, rtms.request_status, arlo.state and
      // notes.updated. Only `error` and `pong` carry none: they are about the
      // connection, have no `data`, and nothing here acts on them.
      const message = readMeetingMessage(event, meetingId);
      if (!message) return;
      const data = message.data;

      switch (message.type) {
        case 'transcript.segment':
          setSegments((prev) => addSegment(prev, message.data?.segment));
          dispatchRtms({ type: 'TRANSCRIPT' });
          // Tell the meeting chat once, on the first real transcript line, and only
          // from the client that started transcription (not from every open panel).
          // Not while this person's own start still waits beside someone else's
          // stream: this line came through that one.
          if (startedHereRef.current && !startNoticeSentRef.current && rtmsRef.current.alongside !== true) {
            startNoticeSentRef.current = true;
            sendChatNoticeRef.current('start');
          }
          break;
        case 'meeting.status': {
          // Confirmed by Zoom's webhook: covers REST-started streams and other clients.
          const status = statusFromWs(message.data?.status);
          if (status) {
            dispatchRtms({ type: 'STATUS', status, source: 'server', fault: message.data?.fault === true });
          }
          if (status === 'stopped' && message.data.meetingEnded === true) setMeetingEnded(true);
          // A stream that starts again proves the meeting goes on
          else if (status === 'started') setMeetingEnded(false);
          break;
        }
        case 'arlo.state':
          // Arlo is in the meeting, so the meeting goes on: covers a missed "started"
          if (data.present === true) setMeetingEnded(false);
          ownPauseOnServerRef.current = data.present === true && data.role === 'owner' && typeof data.myStreamPaused === 'boolean'
            ? data.myStreamPaused
            : null;
          setOwnPauseOnServer(ownPauseOnServerRef.current);
          if (ownPauseOnServerRef.current !== null) {
            dispatchRtms({ type: 'SERVER_PAUSE', paused: ownPauseOnServerRef.current });
          }
          // Whose stream runs. An owner's `myStreamLive` is false while Arlo is
          // here only through another person's stream; a participant has none.
          // A server that does not send it: an owner's stream is taken to run.
          if (data.present === true && (data.role === 'owner' || data.role === 'participant')) {
            const ownStreamLive = data.role === 'owner' && data.myStreamLive !== false;
            besideAnotherStreamRef.current = !ownStreamLive;
            // Confirms a start this person asked for beside someone else's stream
            if (ownStreamLive) dispatchRtms({ type: 'OWN_STREAM_LIVE' });
          } else {
            besideAnotherStreamRef.current = false;
          }
          break;
        case 'participant.event': {
          const incoming = message.data?.event;
          if (incoming) {
            // The same event can arrive here and in the history response
            setParticipantEvents((prev) => (
              incoming.id && prev.some((event) => event.id === incoming.id) ? prev : [...prev, incoming]
            ));
          }
          break;
        }
        case 'subscribed':
          // From here on the server sends this socket every new line, so
          // history loaded now cannot have a gap before the live lines.
          setSubscribedCount((count) => count + 1);
          break;
        case 'rtms.request_status':
          // Zoom's webhook says why a request did not start (3 = host denied)
          console.log('RTMS request status from Zoom:', message.data?.status);
          dispatchRtms({ type: 'REQUEST_STATUS', status: message.data?.status });
          break;
        case 'meeting.presence':
          setViewers(message.data);
          break;
        default:
          break;
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    socket.onclose = (event) => {
      console.log('WebSocket disconnected');
      // 1008 = policy violation: the server rejected our credentials. Retrying
      // with the same token can't succeed, so stop instead of looping.
      if (event?.code === 1008) {
        console.warn('WebSocket rejected: meeting access required');
        setMeetingAccess({ ...NO_ACCESS, status: 'denied', reason: 'The server could not confirm you are in this meeting.' });
        return;
      }
      if (shouldReconnectRef.current) {
        // Clear any existing reconnect timer
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (shouldReconnectRef.current) {
            connectWebSocketRef.current(meetingId);
          }
        }, 5000);
      }
    };

    setWs(socket);
    return socket;
  }, []);

  const connectWebSocket = useCallback((meetingId) => {
    if (!meetingId || meetingId === 'undefined' || meetingId === 'null') {
      console.error('Cannot connect WebSocket without valid meeting ID');
      return null;
    }
    if (connectingRef.current) return null; // a verify+connect is already in flight
    connectingRef.current = true;

    // The socket is opened here and nowhere else, and only once the server
    // has verified access: with the id it verified, which is the one it stamps
    // on every message (`meetingId` is the caller's, from the SDK or the address).
    let stale = false;
    checkMeetingAccess()
      .then((outcome) => {
        if (outcome === 'stale') {
          stale = true;
          return;
        }
        if (outcome === 'verified') {
          openSocket(readVerifiedMeetingId() || meetingId);
          return;
        }
        // No answer at all: keep trying, so the panel comes back by itself when
        // the network or the server does. A refusal is not retried.
        if (accessCheckFailedToRunRef.current && shouldReconnectRef.current) {
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            if (shouldReconnectRef.current) connectWebSocketRef.current(meetingId);
          }, 5000);
        }
      })
      .finally(() => {
        connectingRef.current = false;
        // The check was for a meeting the panel has left. A connect asked for
        // the meeting it is in now was turned away above while that check was
        // in flight: it is made now, with a check of its own.
        const current = meetingIdRef.current;
        if (stale && current && shouldReconnectRef.current) connectWebSocketRef.current(current);
      });
    return null;
  }, [checkMeetingAccess, openSocket, readVerifiedMeetingId]);

  // Reconnect timers call through a ref so they always use the latest callback.
  const connectWebSocketRef = useRef(connectWebSocket);
  connectWebSocketRef.current = connectWebSocket;

  // Confirmed state from the Zoom client: seed on load (panel reopened
  // mid-meeting), then follow onRTMSStatusChange.
  useEffect(() => {
    if (!zoomSdk || !rtmsStatusSupported || !meetingId) return undefined;
    let cancelled = false;
    const handler = (event) => {
      // Status only (no ids): shows in DevTools which events this client receives
      console.log('onRTMSStatusChange:', event?.status);
      dispatchRtms({ type: 'STATUS', status: event?.status, source: 'sdk' });
    };
    try {
      zoomSdk.addEventListener('onRTMSStatusChange', handler);
    } catch (error) {
      console.warn('onRTMSStatusChange not available:', error?.message);
    }
    Promise.resolve()
      .then(() => readRtmsStatus(zoomSdk))
      .then((response) => {
        if (cancelled) return;
        const status = statusFromRtmsStatusList(response?.rtmsStatus);
        console.log('getRTMSStatus:', status || 'no running session');
        if (status) dispatchRtms({ type: 'STATUS', status, source: 'sdk' });
      })
      .catch((error) => console.warn('getRTMSStatus failed:', error?.message));
    return () => {
      cancelled = true;
      try {
        zoomSdk.removeEventListener('onRTMSStatusChange', handler);
      } catch {
        // listener was never registered
      }
    };
  }, [zoomSdk, rtmsStatusSupported, meetingId]);

  // Poll getRTMSStatus while a start is unresolved (see STATUS_POLL_PHASES).
  const lastPolledStatusRef = useRef(null);
  const lastPollLogRef = useRef(null);
  useEffect(() => {
    // Polls even if zoomSdk.config did not accept the status APIs: the call
    // then fails and the reason is logged once, which is worth knowing.
    if (!zoomSdk || !meetingId) return undefined;
    if (!STATUS_POLL_PHASES.has(rtms.phase)) return undefined;
    let cancelled = false;
    const logOnce = (line) => {
      if (line === lastPollLogRef.current) return;
      lastPollLogRef.current = line;
      console.log(line);
    };
    const poll = () => {
      Promise.resolve()
        .then(() => readRtmsStatus(zoomSdk))
        .then((response) => {
          if (cancelled) return;
          // Raw session statuses (no ids), logged when they change: shows what
          // the client reports when the host denies or allows the app.
          const raw = Array.isArray(response?.rtmsStatus)
            ? response.rtmsStatus.map((session) => String(session?.status)).join(', ')
            : 'unexpected response';
          logOnce(`getRTMSStatus poll: [${raw}]`);
          const polled = statusFromPoll(response?.rtmsStatus);
          if (polled === lastPolledStatusRef.current) return;
          lastPolledStatusRef.current = polled;
          if (polled) dispatchRtms({ type: 'STATUS', status: polled, source: 'sdk' });
        })
        .catch((error) => logOnce(`getRTMSStatus poll failed: ${error?.code ?? ''} ${error?.message ?? error}`));
    };
    const interval = setInterval(poll, STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [zoomSdk, meetingId, rtms.phase]);

  // A request that Zoom never confirms must not hang silently.
  useEffect(() => {
    const waiting = rtms.phase === 'requested' || rtms.pending !== null;
    if (!waiting || rtms.waitingLong) return undefined;
    const delay = rtms.phase === 'requested' ? START_CONFIRM_TIMEOUT_MS : ACTION_CONFIRM_TIMEOUT_MS;
    const timer = setTimeout(() => dispatchRtms({ type: 'TIMEOUT', serverPaused: ownPauseOnServerRef.current }), delay);
    return () => clearTimeout(timer);
  }, [rtms.phase, rtms.pending, rtms.waitingLong]);

  // A start request lives 60 seconds. After that the user can request again.
  useEffect(() => {
    if (rtms.phase !== 'requested') {
      setRtmsRequestExpiresAt(null);
      return undefined;
    }
    setRtmsRequestExpiresAt(Date.now() + START_REQUEST_EXPIRY_MS);
    const timer = setTimeout(() => dispatchRtms({ type: 'EXPIRE' }), START_REQUEST_EXPIRY_MS);
    return () => clearTimeout(timer);
  }, [rtms.phase, startAttempt]);

  const notify = useCallback((type, message) => {
    try {
      const result = zoomSdkRef.current?.showNotification({ type, title: 'Arlo', message });
      if (result?.catch) result.catch(() => {});
    } catch {
      // Notifications are best-effort
    }
  }, []);

  // "Started" according to the Zoom client only. If the stream never reaches
  // the server, stop pretending and let the user start it.
  // Only judged while the WebSocket is up: the server reports a running
  // stream on subscribe, so without a socket there is nothing to compare with.
  useEffect(() => {
    if (rtms.phase !== 'starting' || !ws) return undefined;
    const timer = setTimeout(() => dispatchRtms({ type: 'STALL' }), STREAM_ARRIVAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rtms.phase, ws]);

  // Timeline event for the other participants' panels (backend broadcasts it).
  const postTimelineStatus = useCallback((status) => {
    fetch('/api/rtms/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ meetingId: readVerifiedMeetingId() || meetingIdRef.current, status }),
    }).catch(() => {});
  }, [readVerifiedMeetingId]);

  // Side effects run when a state is CONFIRMED, never when a request is sent.
  const prevPhaseRef = useRef(rtms.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const next = rtms.phase;
    if (prev === next) return;
    prevPhaseRef.current = next;
    const local = localActionRef.current;

    if (next === 'active') {
      if ((prev === 'requested' || prev === 'starting') && !alreadyRunningRef.current) {
        notify('info', 'Transcription started');
      }
      if (prev === 'paused' && local === 'resume') {
        sendChatNoticeRef.current('resume');
        postTimelineStatus('rtms_resumed');
      }
      alreadyRunningRef.current = false;
      autoRestartedRef.current = false;
      localActionRef.current = null;
      setStreamStartedHere(startedHereRef.current);
    } else if (next === 'paused') {
      if (local === 'pause') {
        sendChatNoticeRef.current('pause');
        postTimelineStatus('rtms_paused');
      }
      localActionRef.current = null;
    } else if (next === 'stopped') {
      if (local === 'stop') {
        sendChatNoticeRef.current('stop');
        notify('info', 'Transcription stopped');
      }
      // Remembered for a restart after a fault; the server's reason may come later
      stoppedStreamWasOursRef.current = startedHereRef.current && local !== 'stop';
      localActionRef.current = null;
      startedHereRef.current = false;
      setStartAskedHere(false);
      startNoticeSentRef.current = false;
      autoRestartedRef.current = false;
    } else if (next === 'denied' || next === 'failed' || next === 'expired') {
      localActionRef.current = null;
      startedHereRef.current = false;
      setStartAskedHere(false);
    }
    // 'starting' and 'stalled' keep startedHereRef: the stream may still arrive
    // (e.g. the user clicks Zoom's own Start button) and the chat notice is ours.
    if (next === 'stopped' || next === 'idle' || next === 'denied' || next === 'failed' || next === 'expired') {
      setStreamStartedHere(false);
    }
  }, [rtms.phase, notify, postTimelineStatus]);

  // Arlo's status in Zoom's own meeting window (see lib/dynamicIndicator.js)
  useDynamicIndicator({
    zoomSdk,
    supported: dynamicIndicatorSupported,
    text: indicatorText({
      phase: rtms.phase,
      pausedOnServer: ownPauseOnServer === true,
      startedHere: streamStartedHere,
      guest: isGuest,
      voiceEnabled: voiceState.enabled,
      voiceProcessing: voiceState.processing,
    }),
  });
  // Why the indicator is or is not shown, on every change (status only, no content)
  useEffect(() => {
    console.log('[indicator] state:', {
      supported: dynamicIndicatorSupported,
      phase: rtms.phase,
      pausedOnServer: ownPauseOnServer === true,
      startedHere: streamStartedHere,
      guest: isGuest,
    });
  }, [dynamicIndicatorSupported, rtms.phase, ownPauseOnServer, streamStartedHere, isGuest]);
  const reportVoiceState = useCallback((enabled, processing) => {
    setVoiceState((prev) => (
      prev.enabled === enabled && prev.processing === processing ? prev : { enabled, processing }
    ));
  }, []);

  // Denied / failed / unconfirmed requests are shown, not swallowed.
  useEffect(() => {
    if (rtms.error) notify('warning', rtms.error.message);
  }, [rtms.error, notify]);

  const requestRtms = useCallback(async (action, options) => {
    localActionRef.current = action;
    dispatchRtms({ type: 'REQUEST', action, alongside: action === 'start' && besideAnotherStreamRef.current });
    try {
      const apiName = `${action}RTMS`;
      if (options) {
        // The documented startRTMS() takes no options, so the media options
        // still go through callZoomApi.
        await zoomSdk.callZoomApi(apiName, options);
      } else if (rtmsStatusSupported && typeof zoomSdk[apiName] === 'function') {
        await zoomSdk[apiName]();
      } else {
        await zoomSdk.callZoomApi(apiName);
      }
      // Accepted is not confirmed. Without status events on this client the
      // accepted pause/resume/stop is the best signal there is.
      dispatchRtms({ type: 'REQUEST_ACCEPTED', action, confirmsState: !rtmsStatusSupported });
      return true;
    } catch (error) {
      console.error(`${action}RTMS failed:`, error?.code, error?.message);
      localActionRef.current = null;
      if (action === 'start' && String(error?.code) === '10308') {
        alreadyRunningRef.current = true; // already running: no "started" toast
      }
      dispatchRtms({
        type: 'REQUEST_FAILED', action, code: error?.code, message: error?.message, serverPaused: ownPauseOnServerRef.current,
      });
      return false;
    }
  }, [zoomSdk, rtmsStatusSupported]);

  const startRTMS = useCallback(async (isAutoStart = false) => {
    // Also allowed while a request is waiting on the host (see canStartRtms),
    // and, on a person's own click, while Arlo is in the meeting through
    // someone else's stream only: several people can each run one.
    const current = rtmsRef.current;
    const ownBesideAnother = !isAutoStart && !isGuestRef.current && besideAnotherStreamRef.current
      && isRtmsActive(current) && current.pending === null;
    if (!zoomSdk || !(canStartRtms(current) || ownBesideAnother)) return;
    // Their own click is the attempt: no automatic start follows a request that fails
    if (ownBesideAnother) autoStartAttemptedRef.current = true;

    const startingKey = `rtms-starting-${meetingId}`;
    const alreadyStarting = sessionStorage.getItem(startingKey);
    if (alreadyStarting) {
      const elapsed = Date.now() - parseInt(alreadyStarting, 10);
      if (elapsed < 3000) return;
    }
    sessionStorage.setItem(startingKey, Date.now().toString());

    startedHereRef.current = true;
    setStartAskedHere(true);
    autoRestartedRef.current = false;
    setStartAttempt((n) => n + 1);
    try {
      await requestRtms('start', START_OPTIONS);
    } finally {
      sessionStorage.removeItem(startingKey);
    }
  }, [zoomSdk, meetingId, requestRtms]);

  // Allowed by the host but not started: the client says "started", nothing
  // streams. A panel reload fixes it by calling startRTMS again, so do that
  // once for a user who asked for transcription (clicked Start, or auto-start).
  useEffect(() => {
    if (rtms.phase !== 'starting' || !zoomSdk || !ws) return undefined;
    const timer = setTimeout(() => {
      const wantsTranscription = !isGuestRef.current
        && (startedHereRef.current
          || (autoStartAvailableRef.current && localStorage.getItem('arlo-auto-start') !== 'false'));
      if (!shouldAutoRestart({
        phase: rtmsRef.current.phase,
        wantsTranscription,
        alreadyRetried: autoRestartedRef.current,
      })) return;
      autoRestartedRef.current = true;
      startedHereRef.current = true;
      setStartAskedHere(true);
      console.log('RTMS allowed but not streaming: asking Zoom to start again');
      requestRtms('start', START_OPTIONS);
    }, AUTO_RESTART_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rtms.phase, zoomSdk, ws, requestRtms]);

  // Zoom ended the stream because of a connection problem. The client that
  // started it asks for a new stream once; if that fails, the Restart button
  // and the message stay (see shouldRestartAfterFault).
  const faultCode = rtms.phase === 'stopped' ? rtms.error?.code : null;
  useEffect(() => {
    if (faultCode !== STREAM_FAULT || !zoomSdk) return undefined;
    const mayRestart = () => shouldRestartAfterFault({
      phase: rtmsRef.current.phase,
      errorCode: rtmsRef.current.error?.code,
      startedHere: stoppedStreamWasOursRef.current,
      restarts: faultRestartsRef.current,
      guest: isGuestRef.current,
    });
    if (!mayRestart()) return undefined;
    const timer = setTimeout(() => {
      if (!mayRestart()) return;
      stoppedStreamWasOursRef.current = false;
      faultRestartsRef.current += 1;
      startedHereRef.current = true;
      setStartAskedHere(true);
      setStartAttempt((n) => n + 1);
      console.log('RTMS stream ended by a fault: asking Zoom for a new stream');
      requestRtms('start', START_OPTIONS);
    }, FAULT_RESTART_DELAY_MS);
    return () => clearTimeout(timer);
  }, [faultCode, zoomSdk, requestRtms]);

  const stopRTMS = useCallback(async () => {
    const current = rtmsRef.current;
    if (!zoomSdk || isRtmsBusy(current) || !isRtmsActive(current)) return;
    await requestRtms('stop');
  }, [zoomSdk, requestRtms]);

  const pauseRTMS = useCallback(async () => {
    const current = rtmsRef.current;
    if (!zoomSdk || isRtmsBusy(current) || current.phase !== 'active') return;
    await requestRtms('pause');
  }, [zoomSdk, requestRtms]);

  // `pausedOnServer`: the server reports a pause this client was not told
  // about; the stream is this user's, so Zoom is asked to resume it all the same.
  // The server learns of a resume from this panel's report, which is normally
  // sent when the phase goes from paused to active (see the effect above). Here
  // the phase is active all along, so the report is sent once Zoom accepted the
  // resume: without it the server would keep the stream marked paused until
  // its next line.
  const resumeRTMS = useCallback(async ({ pausedOnServer = false } = {}) => {
    const current = rtmsRef.current;
    const onServerOnly = pausedOnServer === true && current.phase === 'active';
    if (!zoomSdk || isRtmsBusy(current) || !(current.phase === 'paused' || onServerOnly)) return;
    const accepted = await requestRtms('resume');
    if (!onServerOnly || !accepted) return;
    // No phase change will clear it
    if (localActionRef.current === 'resume') localActionRef.current = null;
    postTimelineStatus('rtms_resumed');
  }, [zoomSdk, requestRtms, postTimelineStatus]);

  // Start/Stop RTMS via backend REST API (calls Zoom's participant REST API)
  const [apiActionLoading, setApiActionLoading] = useState(false);
  const [apiActionError, setApiActionError] = useState(null);

  const rtmsViaAPI = useCallback(async (action = 'start') => {
    if (apiActionLoading || !meetingId) return { success: false, error: 'No meeting ID' };

    setApiActionLoading(true);
    setApiActionError(null);

    // Get numeric meeting ID as well (live_meetings API may need it)
    const meetingNumber = meetingContext?.meetingID;

    try {
      const response = await fetch('/api/rtms/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId: readVerifiedMeetingId() || meetingId, meetingNumber, action }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Zoom's own reason when it refused the request (data.zoom), else Arlo's
        const errorMsg = data.zoom?.message || data.message || data.error || `Failed to ${action} RTMS via API`;
        setApiActionError(errorMsg);
        return { success: false, error: errorMsg, code: data.code };
      }

      // The REST call only queues the request. The state changes when the
      // webhook (WebSocket meeting.status) or the Zoom client confirms it.
      const current = rtmsRef.current;
      if (action === 'start' && !isRtmsActive(current) && !isRtmsBusy(current)) {
        localActionRef.current = 'start';
        startedHereRef.current = true;
        setStartAskedHere(true);
        dispatchRtms({ type: 'REQUEST', action: 'start' });
      } else if (action === 'stop' && isRtmsActive(current) && !isRtmsBusy(current)) {
        localActionRef.current = 'stop';
        dispatchRtms({ type: 'REQUEST', action: 'stop' });
      }
      return { success: true, data };
    } catch (error) {
      const errorMsg = error.message || 'Network error';
      setApiActionError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setApiActionLoading(false);
    }
  }, [apiActionLoading, meetingId, meetingContext, readVerifiedMeetingId]);

  // Convenience wrappers
  const startRTMSViaAPI = useCallback(() => rtmsViaAPI('start'), [rtmsViaAPI]);
  const stopRTMSViaAPI = useCallback(() => rtmsViaAPI('stop'), [rtmsViaAPI]);

  // Stable ref to startRTMS so the auto-start timer isn't cancelled
  // when the callback reference changes (sendChatNotice/meetingId stabilising)
  const startRTMSRef = useRef(startRTMS);
  useEffect(() => { startRTMSRef.current = startRTMS; }, [startRTMS]);

  // Auto-start RTMS when authenticated and in a meeting (conditional on user preference)
  const { isAuthenticated, user } = useAuth();

  // A transcript and timeline kept after the meeting (with the owner's notes)
  // belong to the person who was signed in. When they stop being signed in
  // (sign-out, session loss, deauthorization) or someone else is, they go.
  // A meeting still running keeps its live transcript: everyone in it sees that.
  const identity = isAuthenticated ? String(user?.id ?? '') : null;
  const identityRef = useRef(identity);
  const meetingEndedRef = useRef(meetingEnded);
  meetingEndedRef.current = meetingEnded;
  useEffect(() => {
    const previous = identityRef.current;
    identityRef.current = identity;
    if (previous === null || previous === identity) return;
    if (meetingIdRef.current && !meetingEndedRef.current) return;
    setRecordRetained(false);
    setSegments([]);
    setParticipantEvents([]);
  }, [identity]);
  useEffect(() => {
    if (autoStartAttemptedRef.current || !isAuthenticated || !meetingId || rtmsActive || rtmsLoading) return;
    // Off unless the deployment turns it on (AUTO_START_RTMS) and the user has not turned it off
    if (!autoStartAvailable || localStorage.getItem('arlo-auto-start') === 'false') return;
    autoStartAttemptedRef.current = true;
    const timer = setTimeout(() => startRTMSRef.current(true), 500);
    return () => clearTimeout(timer);
  }, [isAuthenticated, meetingId, rtmsActive, rtmsLoading, autoStartAvailable]);

  // Check via REST API whether RTMS is already active.
  // Runs immediately (no delay) with retries to handle the race where the meeting
  // record hasn't been created yet (e.g. RTMS auto-started before app opened).
  const accessVerified = meetingAccess.status === 'verified';
  useEffect(() => {
    // The server only answers meeting-scoped routes after access is verified
    if (statusCheckRef.current || !isAuthenticated || !meetingId || !verifiedMeetingId || rtmsActive || !accessVerified) return;
    statusCheckRef.current = true;

    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 3;

    const checkStatus = () => {
      fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(verifiedMeetingId)}`, {
        credentials: 'include',
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (cancelled) return;
          if (data?.meeting?.status === 'ongoing') {
            // Set state but don't send chat notice - wait for actual transcript data
            dispatchRtms({ type: 'STATUS', status: 'started', source: 'server' });
          } else if (++attempt < maxAttempts) {
            // Meeting record may not exist yet — retry after 1s
            setTimeout(() => { if (!cancelled) checkStatus(); }, 1000);
          }
        })
        .catch(() => {
          if (!cancelled && ++attempt < maxAttempts) {
            setTimeout(() => { if (!cancelled) checkStatus(); }, 1000);
          }
        });
    };

    checkStatus();
    return () => { cancelled = true; };
  }, [isAuthenticated, meetingId, verifiedMeetingId, rtmsActive, accessVerified]);

  // What the server holds for this meeting so far: the transcript and timeline
  // from before this panel opened, or from while its connection was down.
  // Loaded when access is verified, when the socket is replaced, and again when
  // the server confirms the subscription (only then is every new line sent
  // live, so that load closes the gap). Merging drops what is already here.
  useEffect(() => {
    if (!meetingId || !verifiedMeetingId || !accessVerified) return undefined;
    let cancelled = false;
    const load = (path) => fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(verifiedMeetingId)}/${path}`, {
      credentials: 'include',
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null);

    load('transcript').then((data) => {
      if (cancelled || !Array.isArray(data?.segments) || data.segments.length === 0) return;
      setSegments((live) => mergeHistory(data.segments, live));
    });
    load('participant-events').then((data) => {
      if (cancelled || !Array.isArray(data?.events) || data.events.length === 0) return;
      setParticipantEvents((live) => {
        const storedIds = new Set(data.events.map((event) => event.id));
        return [...data.events, ...live.filter((event) => !storedIds.has(event.id))];
      });
    });
    return () => { cancelled = true; };
  }, [meetingId, verifiedMeetingId, accessVerified, ws, subscribedCount]);

  // Send Zoom meeting topic to backend to replace generic "Meeting M/D/YYYY" title
  // Wait for rtmsActive so the meeting record exists in the DB before patching
  useEffect(() => {
    const topic = meetingContext?.meetingTopic;
    const meetingNumber = meetingContext?.meetingID;
    if (!rtmsActive || !meetingId || !verifiedMeetingId || !topic || titleSentRef.current || titleUserRenamedRef.current) return;
    titleSentRef.current = true;

    let attempts = 0;
    const sendTitle = () => {
      fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(verifiedMeetingId)}/topic`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: topic, meetingNumber }),
      }).then(res => {
        // Meeting record may not exist yet — retry after delay (max 3 attempts).
        // Backend returns 202 (pending) or 404 until RTMS creates the row.
        if ((res.status === 202 || res.status === 404) && ++attempts < 3) {
          setTimeout(sendTitle, 3000);
        }
      }).catch(() => {});
    };
    sendTitle();
  }, [rtmsActive, meetingId, verifiedMeetingId, meetingContext?.meetingTopic, meetingContext?.meetingID]);

  const setTitleUserRenamed = useCallback(() => {
    titleUserRenamedRef.current = true;
  }, []);

  // The render between Zoom reporting another meeting and the reset above:
  // the previous meeting's transcript and state are already not shown.
  const switchingMeeting = Boolean(meetingId) && lastMeetingId !== null && lastMeetingId !== meetingId;
  // This panel was in a meeting and no longer is: for it, that meeting is over
  const leftMeeting = lastMeetingId !== null && (!meetingId || runningContext !== 'inMeeting');
  const shownSegments = switchingMeeting ? NOTHING : segments;
  const shownParticipantEvents = switchingMeeting ? NOTHING : participantEvents;
  const shownMeetingEnded = meetingEnded && !switchingMeeting;

  const contextValue = useMemo(() => ({
    rtmsActive,
    rtmsPaused,
    rtmsLoading,
    rtmsPhase: rtms.phase,
    rtmsError: rtms.error,
    rtmsWaitingLong: rtms.waitingLong,
    rtmsRequestExpiresAt,
    ws,
    meetingId,
    verifiedMeetingId,
    startAskedHere,
    lastMeetingId,
    switchingMeeting,
    leftMeeting,
    meetingEnded: shownMeetingEnded,
    meetingStartTime: meetingStartTimeRef.current,
    autoStartAttemptedRef,
    viewers,
    segments: shownSegments,
    participantEvents: shownParticipantEvents,
    setRecordRetained,
    meetingAccess,
    verifyMeetingAccess,
    startRTMS,
    stopRTMS,
    pauseRTMS,
    resumeRTMS,
    startRTMSViaAPI,
    stopRTMSViaAPI,
    apiActionLoading,
    apiActionError,
    connectWebSocket,
    setWs,
    setTitleUserRenamed,
    reportVoiceState,
  }), [reportVoiceState, rtmsActive, rtmsPaused, rtmsLoading, rtms.phase, rtms.error, rtms.waitingLong, rtmsRequestExpiresAt, ws, meetingId, verifiedMeetingId, startAskedHere, lastMeetingId, switchingMeeting, leftMeeting, shownMeetingEnded, viewers, shownSegments, shownParticipantEvents, meetingAccess, verifyMeetingAccess, startRTMS, stopRTMS, pauseRTMS, resumeRTMS, startRTMSViaAPI, stopRTMSViaAPI, apiActionLoading, apiActionError, connectWebSocket, setWs, setTitleUserRenamed]);

  return (
    <MeetingContext.Provider value={contextValue}>
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeeting() {
  const context = useContext(MeetingContext);
  if (!context) {
    throw new Error('useMeeting must be used within a MeetingProvider');
  }
  return context;
}
