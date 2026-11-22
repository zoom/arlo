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
} from '../lib/rtmsMachine';

const MeetingContext = createContext();

// How long to wait for Zoom to confirm a request before saying so in the UI.
const START_CONFIRM_TIMEOUT_MS = 30000;
const ACTION_CONFIRM_TIMEOUT_MS = 10000;

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
  const { zoomSdk, meetingContext, isGuest, userContext, rtmsStatusSupported } = useZoomSdk();
  const { demoMode } = useServerSettings();
  // Transcription state changes only on confirmed signals (see lib/rtmsMachine.js).
  const [rtms, dispatchRtms] = useReducer(rtmsReducer, initialRtmsState);
  const rtmsActive = isRtmsActive(rtms);
  const rtmsPaused = isRtmsPaused(rtms);
  const rtmsLoading = isRtmsBusy(rtms);
  const [ws, setWs] = useState(null);
  const [viewers, setViewers] = useState(null);
  // Server-verified meeting access (Zoom App Context). status:
  // 'idle' | 'verifying' | 'verified' | 'denied' | 'unavailable'
  const [meetingAccess, setMeetingAccess] = useState({ status: 'idle', isGuest: null, reason: null });

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
  // The request this client made and is waiting on. Chat notices and timeline
  // events fire when Zoom confirms it, and only on the client that asked.
  const localActionRef = useRef(null);
  const startedHereRef = useRef(false);
  const alreadyRunningRef = useRef(false);
  const isGuestRef = useRef(isGuest);
  const userContextRef = useRef(userContext);
  isGuestRef.current = isGuest;
  userContextRef.current = userContext;

  const meetingId = meetingContext?.meetingUUID;
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;

  if (rtmsActive) {
    hasBeenActiveRef.current = true;
    if (!meetingStartTimeRef.current) meetingStartTimeRef.current = Date.now();
  }

  // Clean up when meeting ends (meetingId becomes falsy) and prepare for new meetings
  useEffect(() => {
    if (meetingId) {
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
      alreadyRunningRef.current = false;
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
    }
  }, [meetingId]);

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
  const verifyMeetingAccess = useCallback(async () => {
    const sdk = zoomSdkRef.current;
    if (!sdk || typeof sdk.getAppContext !== 'function') {
      setMeetingAccess({ status: 'unavailable', isGuest: null, reason: 'Open Arlo inside a Zoom meeting to see the live transcript.' });
      return false;
    }
    setMeetingAccess((prev) => ({ ...prev, status: 'verifying', reason: null }));
    try {
      const { context } = await sdk.getAppContext();
      const res = await fetch('/api/auth/meeting-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ appContext: context }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMeetingAccess({ status: 'denied', isGuest: null, reason: data.error || 'Could not verify your meeting.' });
        return false;
      }
      setMeetingAccess({ status: 'verified', isGuest: !!data.isGuest, reason: null });
      return true;
    } catch (error) {
      console.error('Meeting access verification failed:', error);
      setMeetingAccess({ status: 'denied', isGuest: null, reason: 'Could not read your Zoom meeting context.' });
      return false;
    }
  }, []);

  const openSocket = useCallback((token, meetingId) => {

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
    let wsUrl = `${protocol}//${hostname}/ws?meeting_id=${encodeURIComponent(meetingId)}`;
    if (token) {
      wsUrl += `&token=${encodeURIComponent(token)}`;
    }

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
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'transcript.segment':
          dispatchRtms({ type: 'TRANSCRIPT' });
          // Tell the meeting chat once, on the first real transcript line, and only
          // from the client that started transcription (not from every open panel).
          if (startedHereRef.current && !startNoticeSentRef.current) {
            startNoticeSentRef.current = true;
            sendChatNoticeRef.current('start');
          }
          break;
        case 'meeting.status': {
          // Confirmed by Zoom's webhook: covers REST-started streams and other clients.
          const status = statusFromWs(message.data?.status);
          if (status) dispatchRtms({ type: 'STATUS', status, source: 'server' });
          break;
        }
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
        setMeetingAccess({ status: 'denied', isGuest: null, reason: 'The server could not confirm you are in this meeting.' });
        return;
      }
      if (shouldReconnectRef.current) {
        // Clear any existing reconnect timer
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (shouldReconnectRef.current) {
            connectWebSocketRef.current(token, meetingId);
          }
        }, 5000);
      }
    };

    setWs(socket);
    return socket;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectWebSocket = useCallback((token, meetingId) => {
    if (!meetingId || meetingId === 'undefined' || meetingId === 'null') {
      console.error('Cannot connect WebSocket without valid meeting ID');
      return null;
    }
    if (connectingRef.current) return null; // a verify+connect is already in flight
    connectingRef.current = true;

    verifyMeetingAccess()
      .then((ok) => {
        if (ok) openSocket(token, meetingId);
      })
      .finally(() => {
        connectingRef.current = false;
      });
    return null;
  }, [verifyMeetingAccess, openSocket]);

  // Reconnect timers call through a ref so they always use the latest callback.
  const connectWebSocketRef = useRef(connectWebSocket);
  connectWebSocketRef.current = connectWebSocket;

  // Confirmed state from the Zoom client: seed on load (panel reopened
  // mid-meeting), then follow onRTMSStatusChange.
  useEffect(() => {
    if (!zoomSdk || !rtmsStatusSupported || !meetingId) return undefined;
    let cancelled = false;
    const handler = (event) => {
      dispatchRtms({ type: 'STATUS', status: event?.status, source: 'sdk' });
    };
    try {
      zoomSdk.addEventListener('onRTMSStatusChange', handler);
    } catch (error) {
      console.warn('onRTMSStatusChange not available:', error?.message);
    }
    Promise.resolve()
      .then(() => (typeof zoomSdk.getRTMSStatus === 'function'
        ? zoomSdk.getRTMSStatus()
        : zoomSdk.callZoomApi('getRTMSStatus')))
      .then((response) => {
        if (cancelled) return;
        const status = statusFromRtmsStatusList(response?.rtmsStatus);
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

  // A request that Zoom never confirms must not hang silently.
  useEffect(() => {
    const waiting = rtms.phase === 'requested' || rtms.pending !== null;
    if (!waiting || rtms.waitingLong) return undefined;
    const delay = rtms.phase === 'requested' ? START_CONFIRM_TIMEOUT_MS : ACTION_CONFIRM_TIMEOUT_MS;
    const timer = setTimeout(() => dispatchRtms({ type: 'TIMEOUT' }), delay);
    return () => clearTimeout(timer);
  }, [rtms.phase, rtms.pending, rtms.waitingLong]);

  const notify = useCallback((type, message) => {
    try {
      const result = zoomSdkRef.current?.showNotification({ type, title: 'Arlo', message });
      if (result?.catch) result.catch(() => {});
    } catch {
      // Notifications are best-effort
    }
  }, []);

  // Timeline event for the other participants' panels (backend broadcasts it).
  const postTimelineStatus = useCallback((status) => {
    fetch('/api/rtms/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ meetingId: meetingIdRef.current, status }),
    }).catch(() => {});
  }, []);

  // Side effects run when a state is CONFIRMED, never when a request is sent.
  const prevPhaseRef = useRef(rtms.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const next = rtms.phase;
    if (prev === next) return;
    prevPhaseRef.current = next;
    const local = localActionRef.current;

    if (next === 'active') {
      if (prev === 'requested' && !alreadyRunningRef.current) {
        notify('info', 'Transcription started');
      }
      if (prev === 'paused' && local === 'resume') {
        sendChatNoticeRef.current('resume');
        postTimelineStatus('rtms_resumed');
      }
      alreadyRunningRef.current = false;
      localActionRef.current = null;
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
      localActionRef.current = null;
      startedHereRef.current = false;
      startNoticeSentRef.current = false;
    } else if (next === 'denied' || next === 'failed') {
      localActionRef.current = null;
      startedHereRef.current = false;
    }
  }, [rtms.phase, notify, postTimelineStatus]);

  // Denied / failed / unconfirmed requests are shown, not swallowed.
  useEffect(() => {
    if (rtms.error) notify('warning', rtms.error.message);
  }, [rtms.error, notify]);

  const requestRtms = useCallback(async (action, options) => {
    localActionRef.current = action;
    dispatchRtms({ type: 'REQUEST', action });
    try {
      const apiName = `${action}RTMS`;
      if (options) {
        await zoomSdk.callZoomApi(apiName, options);
      } else {
        await zoomSdk.callZoomApi(apiName);
      }
      // Accepted is not confirmed. Without status events on this client the
      // accepted pause/resume/stop is the best signal there is.
      dispatchRtms({ type: 'REQUEST_ACCEPTED', action, confirmsState: !rtmsStatusSupported });
    } catch (error) {
      console.error(`${action}RTMS failed:`, error?.code, error?.message);
      localActionRef.current = null;
      if (action === 'start' && String(error?.code) === '10308') {
        alreadyRunningRef.current = true; // already running: no "started" toast
      }
      dispatchRtms({ type: 'REQUEST_FAILED', action, code: error?.code, message: error?.message });
    }
  }, [zoomSdk, rtmsStatusSupported]);

  const startRTMS = useCallback(async (isAutoStart = false) => {
    const current = rtmsRef.current;
    if (!zoomSdk || isRtmsBusy(current) || isRtmsActive(current)) return;

    const startingKey = `rtms-starting-${meetingId}`;
    const alreadyStarting = sessionStorage.getItem(startingKey);
    if (alreadyStarting) {
      const elapsed = Date.now() - parseInt(alreadyStarting, 10);
      if (elapsed < 3000) return;
    }
    sessionStorage.setItem(startingKey, Date.now().toString());

    startedHereRef.current = true;
    try {
      await requestRtms('start', {
        audioOptions: { rawAudio: false },
        transcriptOptions: { caption: true },
      });
    } finally {
      sessionStorage.removeItem(startingKey);
    }
  }, [zoomSdk, meetingId, requestRtms]);

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

  const resumeRTMS = useCallback(async () => {
    const current = rtmsRef.current;
    if (!zoomSdk || isRtmsBusy(current) || current.phase !== 'paused') return;
    await requestRtms('resume');
  }, [zoomSdk, requestRtms]);

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
        body: JSON.stringify({ meetingId, meetingNumber, action }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.message || data.error || `Failed to ${action} RTMS via API`;
        setApiActionError(errorMsg);
        return { success: false, error: errorMsg, code: data.code };
      }

      // The REST call only queues the request. The state changes when the
      // webhook (WebSocket meeting.status) or the Zoom client confirms it.
      const current = rtmsRef.current;
      if (action === 'start' && !isRtmsActive(current) && !isRtmsBusy(current)) {
        localActionRef.current = 'start';
        startedHereRef.current = true;
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
  }, [apiActionLoading, meetingId, meetingContext]);

  // Convenience wrappers
  const startRTMSViaAPI = useCallback(() => rtmsViaAPI('start'), [rtmsViaAPI]);
  const stopRTMSViaAPI = useCallback(() => rtmsViaAPI('stop'), [rtmsViaAPI]);

  // Stable ref to startRTMS so the auto-start timer isn't cancelled
  // when the callback reference changes (sendChatNotice/meetingId stabilising)
  const startRTMSRef = useRef(startRTMS);
  useEffect(() => { startRTMSRef.current = startRTMS; }, [startRTMS]);

  // Auto-start RTMS when authenticated and in a meeting (conditional on user preference)
  const { isAuthenticated } = useAuth();
  useEffect(() => {
    if (autoStartAttemptedRef.current || !isAuthenticated || !meetingId || rtmsActive || rtmsLoading) return;
    if (localStorage.getItem('arlo-auto-start') === 'false') return;
    autoStartAttemptedRef.current = true;
    const timer = setTimeout(() => startRTMSRef.current(true), 500);
    return () => clearTimeout(timer);
  }, [isAuthenticated, meetingId, rtmsActive, rtmsLoading]);

  // Check via REST API whether RTMS is already active.
  // Runs immediately (no delay) with retries to handle the race where the meeting
  // record hasn't been created yet (e.g. RTMS auto-started before app opened).
  useEffect(() => {
    if (statusCheckRef.current || !isAuthenticated || !meetingId || rtmsActive) return;
    statusCheckRef.current = true;

    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 3;

    const checkStatus = () => {
      fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}`, {
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
  }, [isAuthenticated, meetingId, rtmsActive]);

  // Send Zoom meeting topic to backend to replace generic "Meeting M/D/YYYY" title
  // Wait for rtmsActive so the meeting record exists in the DB before patching
  useEffect(() => {
    const topic = meetingContext?.meetingTopic;
    const meetingNumber = meetingContext?.meetingID;
    if (!rtmsActive || !meetingId || !topic || titleSentRef.current || titleUserRenamedRef.current) return;
    titleSentRef.current = true;

    let attempts = 0;
    const sendTitle = () => {
      fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/topic`, {
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
  }, [rtmsActive, meetingId, meetingContext?.meetingTopic, meetingContext?.meetingID]);

  const setTitleUserRenamed = useCallback(() => {
    titleUserRenamedRef.current = true;
  }, []);

  const contextValue = useMemo(() => ({
    rtmsActive,
    rtmsPaused,
    rtmsLoading,
    rtmsPhase: rtms.phase,
    rtmsError: rtms.error,
    rtmsWaitingLong: rtms.waitingLong,
    ws,
    meetingId,
    meetingStartTime: meetingStartTimeRef.current,
    autoStartAttemptedRef,
    viewers,
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
  }), [rtmsActive, rtmsPaused, rtmsLoading, rtms.phase, rtms.error, rtms.waitingLong, ws, meetingId, viewers, meetingAccess, verifyMeetingAccess, startRTMS, stopRTMS, pauseRTMS, resumeRTMS, startRTMSViaAPI, stopRTMSViaAPI, apiActionLoading, apiActionError, connectWebSocket, setWs, setTitleUserRenamed]);

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
