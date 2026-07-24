import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useZoomSdk } from './ZoomSdkContext';
import { useAuth } from './AuthContext';

const MeetingContext = createContext();

const DEFAULT_CHAT_NOTICES = {
  enabled: true,
  events: { start: true, pause: true, resume: true, stop: false, restart: false },
  messages: {
    start: "I'm using a Zoom app, Arlo, to transcribe this meeting and generate a summary.",
    pause: 'Transcription paused.',
    resume: 'Transcription resumed.',
    stop: 'Transcription stopped. Transcript will be available shortly.',
    restart: 'Transcription restarted.',
  },
};

const WS_HEARTBEAT_INTERVAL_MS = 25000;
const WS_STALE_TIMEOUT_MS = 75000;
const WS_RECONNECT_BASE_DELAY_MS = 1000;
const WS_RECONNECT_MAX_DELAY_MS = 30000;
const RTMS_START_TIMEOUT_MS = 45000;

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timeoutId)),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function pickRtmsSessionId(statusResponse) {
  const sessions = statusResponse?.rtmsStatus ||
    statusResponse?.sessions ||
    statusResponse?.rtmsSessions ||
    [];
  const list = Array.isArray(sessions) ? sessions : [sessions].filter(Boolean);
  const active = list.find((session) => ['connecting', 'started', 'resumed', 'paused'].includes(session?.status)) ||
    list[0];
  return active?.rtmsSessionId ||
    active?.sessionId ||
    active?.rtms_stream_id ||
    active?.streamId ||
    null;
}

function pickMeetingID(meetingContext) {
  const candidate = meetingContext?.meetingID ||
    meetingContext?.meetingId ||
    meetingContext?.meetingNumber ||
    meetingContext?.id ||
    null;
  if (!candidate) return null;
  const normalized = String(candidate).replace(/\s+/g, '');
  return /^\d{9,20}$/.test(normalized) ? normalized : null;
}

function buildWebSocketUrl(meetingId, token, metadata = {}) {
  const configuredBase = process.env.REACT_APP_WS_URL;
  const defaultProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let base = configuredBase || `${defaultProtocol}//${window.location.hostname}`;

  if (base.startsWith('https://')) {
    base = base.replace(/^https:\/\//, 'wss://');
  } else if (base.startsWith('http://')) {
    base = base.replace(/^http:\/\//, 'ws://');
  }

  base = base.replace(/\/+$/, '');
  if (!base.endsWith('/ws')) {
    base = `${base}/ws`;
  }

  const params = new URLSearchParams({ meeting_uuid: meetingId });
  if (token) params.set('token', token);
  if (metadata.sessionId) params.set('session_id', metadata.sessionId);
  if (metadata.meetingID) params.set('meetingid', metadata.meetingID);
  return `${base}?${params.toString()}`;
}

export function MeetingProvider({ children }) {
  const { zoomSdk, meetingContext, isGuest, userContext } = useZoomSdk();
  const { user } = useAuth();
  const [rtmsActive, setRtmsActive] = useState(false);
  const [rtmsPaused, setRtmsPaused] = useState(false);
  const [rtmsLoading, setRtmsLoading] = useState(false);
  const [rtmsSessionId, setRtmsSessionId] = useState(null);
  const [ws, setWs] = useState(null);
  const [viewers, setViewers] = useState(null);

  const meetingStartTimeRef = useRef(null);
  const autoStartAttemptedRef = useRef(false);
  const titleSentRef = useRef(false);
  const hasBeenActiveRef = useRef(false);
  const statusCheckRef = useRef(false);
  const titleUserRenamedRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const startNoticeSentRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const staleTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const wsRef = useRef(null);
  const rtmsActiveRef = useRef(rtmsActive);
  const rtmsSessionIdRef = useRef(rtmsSessionId);
  const isGuestRef = useRef(isGuest);
  const userContextRef = useRef(userContext);
  const meetingContextRef = useRef(meetingContext);
  const authUserRef = useRef(user);
  isGuestRef.current = isGuest;
  userContextRef.current = userContext;
  meetingContextRef.current = meetingContext;
  authUserRef.current = user;

  useEffect(() => { rtmsActiveRef.current = rtmsActive; }, [rtmsActive]);
  useEffect(() => { rtmsSessionIdRef.current = rtmsSessionId; }, [rtmsSessionId]);

  const meetingId = meetingContext?.meetingUUID;

  const clearWebSocketTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }, []);

  const markWebSocketAlive = useCallback((socket) => {
    socket.lastSeenAt = Date.now();
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
    }
    staleTimerRef.current = setTimeout(() => {
      if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
      const ageMs = Date.now() - (socket.lastSeenAt || 0);
      if (ageMs >= WS_STALE_TIMEOUT_MS) {
        console.warn('WebSocket stale; closing to trigger reconnect');
        socket.shouldReconnect = true;
        socket.close(4000, 'stale connection');
      }
    }, WS_STALE_TIMEOUT_MS);
  }, []);

  const startWebSocketHeartbeat = useCallback((socket) => {
    clearWebSocketTimers();
    markWebSocketAlive(socket);
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } catch (error) {
        console.warn('WebSocket heartbeat failed; closing to trigger reconnect', error);
        socket.shouldReconnect = true;
        socket.close();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
  }, [clearWebSocketTimers, markWebSocketAlive]);

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
    } else {
      // Meeting ended — stop reconnecting, close WS, reset state
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      clearWebSocketTimers();
      setRtmsActive(false);
      setRtmsPaused(false);
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.shouldReconnect = false;
        wsRef.current.close();
      }
      wsRef.current = null;
      setWs(null);
      reconnectAttemptRef.current = 0;
    }
  }, [clearWebSocketTimers, meetingId]);

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
      const message = meetingId
        ? template.replace(/\[meeting-id\]/g, meetingId)
        : template;
      zoomSdk.sendMessageToChat({ message }).catch(() => {});
    } catch {
      // Silently ignore — chat notices are best-effort
    }
  }, [zoomSdk, meetingId]);

  // Stable ref so detection paths (WS handler, REST fallback) can send chat notices
  const sendChatNoticeRef = useRef(sendChatNotice);
  useEffect(() => { sendChatNoticeRef.current = sendChatNotice; }, [sendChatNotice]);

  const refreshRtmsSessionId = useCallback(async () => {
    if (!zoomSdk) return rtmsSessionIdRef.current;

    try {
      const response = typeof zoomSdk.callZoomApi === 'function'
        ? await zoomSdk.callZoomApi('getRTMSStatus')
        : await zoomSdk.getRTMSStatus?.();
      const nextSessionId = pickRtmsSessionId(response);
      if (nextSessionId && nextSessionId !== rtmsSessionIdRef.current) {
        rtmsSessionIdRef.current = nextSessionId;
        setRtmsSessionId(nextSessionId);
      }
      return nextSessionId || rtmsSessionIdRef.current;
    } catch (error) {
      console.warn('getRTMSStatus failed:', error);
      return rtmsSessionIdRef.current;
    }
  }, [zoomSdk]);

  const connectWebSocket = useCallback(async (token, meetingId) => {
    if (!meetingId || meetingId === 'undefined' || meetingId === 'null') {
      console.error('Cannot connect WebSocket without valid meeting ID');
      return null;
    }

    const existingSocket = wsRef.current;
    if (
      existingSocket
      && existingSocket.meetingId === meetingId
      && (existingSocket.readyState === WebSocket.CONNECTING || existingSocket.readyState === WebSocket.OPEN)
    ) {
      return existingSocket;
    }

    const resolvedRtmsSessionId = rtmsSessionIdRef.current || await refreshRtmsSessionId();
    if (!resolvedRtmsSessionId) {
      console.warn('Skipping WebSocket connection until RTMS session id is available');
      return null;
    }

    if (existingSocket && existingSocket.readyState !== WebSocket.CLOSED) {
      existingSocket.shouldReconnect = false;
      existingSocket.close();
    }

    clearWebSocketTimers();

    const sdkMeeting = meetingContextRef.current;
    const sessionMetadata = {
      sessionId: resolvedRtmsSessionId,
      meetingID: pickMeetingID(sdkMeeting),
    };

    const wsUrl = buildWebSocketUrl(meetingId, token, sessionMetadata);
    const socket = new WebSocket(wsUrl);
    socket.meetingId = meetingId;
    socket.rtmsStreamId = sessionMetadata.sessionId;
    socket.shouldReconnect = true;
    wsRef.current = socket;

    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      startWebSocketHeartbeat(socket);
      console.log('WebSocket connected', buildWebSocketUrl(meetingId, null, sessionMetadata));
      const ctx = userContextRef.current;
      const participantName = ctx?.screenName || ctx?.firstName || null;
      socket.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          meetingUUID: meetingId,
          participantName,
          isGuest: !!isGuestRef.current,
          sessionId: sessionMetadata.sessionId,
          rtmsStreamId: sessionMetadata.sessionId,
          meetingID: sessionMetadata.meetingID,
        },
      }));
    };

    socket.onmessage = (event) => {
      markWebSocketAlive(socket);
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'connected':
        case 'subscribed':
        case 'pong':
          break;
        case 'transcript.segment':
          if (!rtmsActiveRef.current) {
            setRtmsActive(true);
            if (!meetingStartTimeRef.current) {
              meetingStartTimeRef.current = Date.now();
            }
          }
          break;
        case 'meeting.status':
          if (message.data.status === 'rtms_started') {
            setRtmsActive(true);
            hasBeenActiveRef.current = true;
            if (!startNoticeSentRef.current) {
              startNoticeSentRef.current = true;
              sendChatNoticeRef.current('start');
            }
          } else if (message.data.status === 'rtms_stopped') {
            setRtmsActive(false);
            setRtmsPaused(false);
          }
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

    socket.onclose = () => {
      console.log('WebSocket disconnected');
      const isCurrentSocket = wsRef.current === socket;
      if (isCurrentSocket) {
        clearWebSocketTimers();
        wsRef.current = null;
        setWs(prev => prev === socket ? null : prev);
      }
      if (isCurrentSocket && socket.shouldReconnect && shouldReconnectRef.current) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectAttemptRef.current += 1;
        const backoffMs = Math.min(
          WS_RECONNECT_MAX_DELAY_MS,
          WS_RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, reconnectAttemptRef.current - 1))
        );
        const jitterMs = Math.floor(Math.random() * 500);
        reconnectTimerRef.current = setTimeout(() => {
          if (shouldReconnectRef.current) {
            connectWebSocket(token, meetingId);
          }
        }, backoffMs + jitterMs);
      }
    };

    setWs(socket);
    return socket;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearWebSocketTimers, markWebSocketAlive, refreshRtmsSessionId, startWebSocketHeartbeat]);

  useEffect(() => {
    if (!zoomSdk || !meetingId) return;
    refreshRtmsSessionId();
  }, [meetingId, refreshRtmsSessionId, zoomSdk]);

  useEffect(() => {
    if (!zoomSdk?.onRTMSStatusChange || !meetingId) return;
    try {
      zoomSdk.onRTMSStatusChange((event) => {
        const nextSessionId = pickRtmsSessionId({ rtmsStatus: [event] });
        if (nextSessionId) {
          rtmsSessionIdRef.current = nextSessionId;
          setRtmsSessionId(nextSessionId);
        }
        if (event?.status === 'started' || event?.status === 'resumed') {
          setRtmsActive(true);
          setRtmsPaused(false);
        } else if (event?.status === 'paused') {
          setRtmsPaused(true);
        } else if (event?.status === 'stopped') {
          setRtmsActive(false);
          setRtmsPaused(false);
          setRtmsSessionId(null);
          rtmsSessionIdRef.current = null;
        }
      });
    } catch (error) {
      console.warn('onRTMSStatusChange registration failed:', error);
    }
  }, [meetingId, zoomSdk]);

  const startRTMS = useCallback(async (isAutoStart = false) => {
    if (rtmsLoading || !zoomSdk) return;

    const startingKey = `rtms-starting-${meetingId}`;
    const alreadyStarting = sessionStorage.getItem(startingKey);
    if (alreadyStarting) {
      const elapsed = Date.now() - parseInt(alreadyStarting, 10);
      if (elapsed < 3000) return;
    }

    sessionStorage.setItem(startingKey, Date.now().toString());
    setRtmsLoading(true);

    try {
      await withTimeout(zoomSdk.callZoomApi('startRTMS', {
        audioOptions: { rawAudio: false },
        transcriptOptions: { caption: true },
      }), RTMS_START_TIMEOUT_MS, 'Timed out waiting for Zoom to start RTMS');
      await refreshRtmsSessionId();

      setRtmsActive(true);
      if (!meetingStartTimeRef.current) {
        meetingStartTimeRef.current = Date.now();
      }
      sessionStorage.removeItem(startingKey);

      // Send chat notice: restart if previously active, otherwise start
      if (hasBeenActiveRef.current) {
        sendChatNotice('restart');
      } else {
        sendChatNotice('start');
        hasBeenActiveRef.current = true;
      }
      startNoticeSentRef.current = true;

      zoomSdk.showNotification({
        type: 'success',
        title: 'Arlo',
        message: 'Transcription started',
      }).catch(() => {});
    } catch (error) {
      if (error?.code === '10308') {
        // 10308 = RTMS already running — treat as success
        setRtmsActive(true);
        await refreshRtmsSessionId();
        hasBeenActiveRef.current = true;
        if (!meetingStartTimeRef.current) {
          meetingStartTimeRef.current = Date.now();
        }
        if (!startNoticeSentRef.current) {
          startNoticeSentRef.current = true;
          sendChatNotice('start');
        }
        setTimeout(() => sessionStorage.removeItem(startingKey), 2000);
        setRtmsLoading(false);
        return;
      }
      sessionStorage.removeItem(startingKey);
      zoomSdk.showNotification({
        type: 'error',
        title: 'Arlo',
        message: error?.message || 'Failed to start transcription',
      }).catch(() => {});
    } finally {
      setRtmsLoading(false);
    }
  }, [rtmsLoading, zoomSdk, meetingId, refreshRtmsSessionId, sendChatNotice]);

  const stopRTMS = useCallback(async () => {
    if (rtmsLoading || !zoomSdk) return;

    setRtmsLoading(true);
    try {
      await zoomSdk.callZoomApi('stopRTMS');
      setRtmsActive(false);
      setRtmsPaused(false);

      sendChatNotice('stop');

      zoomSdk.showNotification({
        type: 'info',
        title: 'Arlo',
        message: 'Transcription paused',
      }).catch(() => {});
    } catch {
      setRtmsActive(false);
      setRtmsPaused(false);
    } finally {
      setRtmsLoading(false);
    }
  }, [rtmsLoading, zoomSdk, sendChatNotice]);

  const pauseRTMS = useCallback(async () => {
    if (rtmsLoading || !zoomSdk) return;
    setRtmsLoading(true);
    try {
      await zoomSdk.callZoomApi('pauseRTMS');
      setRtmsPaused(true);
      sendChatNotice('pause');
    } catch (error) {
      console.error('pauseRTMS failed:', error);
    } finally {
      setRtmsLoading(false);
    }
  }, [rtmsLoading, zoomSdk, sendChatNotice]);

  const resumeRTMS = useCallback(async () => {
    if (rtmsLoading || !zoomSdk) return;
    setRtmsLoading(true);
    try {
      await zoomSdk.callZoomApi('resumeRTMS');
      setRtmsPaused(false);
      sendChatNotice('resume');
    } catch (error) {
      console.error('resumeRTMS failed:', error);
    } finally {
      setRtmsLoading(false);
    }
  }, [rtmsLoading, zoomSdk, sendChatNotice]);

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
            console.log('REST status check: meeting is ongoing, setting rtmsActive');
            setRtmsActive(true);
            hasBeenActiveRef.current = true;
            if (!meetingStartTimeRef.current) {
              meetingStartTimeRef.current = Date.now();
            }
            if (!startNoticeSentRef.current) {
              startNoticeSentRef.current = true;
              sendChatNoticeRef.current('start');
            }
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
        // Meeting record may not exist yet — retry after delay (max 3 attempts)
        if (res.status === 202 && ++attempts < 3) {
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
    ws,
    meetingId,
    rtmsSessionId,
    meetingStartTime: meetingStartTimeRef.current,
    autoStartAttemptedRef,
    viewers,
    startRTMS,
    stopRTMS,
    pauseRTMS,
    resumeRTMS,
    connectWebSocket,
    setWs,
    setTitleUserRenamed,
  }), [rtmsActive, rtmsPaused, rtmsLoading, ws, meetingId, rtmsSessionId, viewers, startRTMS, stopRTMS, pauseRTMS, resumeRTMS, connectWebSocket, setWs, setTitleUserRenamed]);

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
