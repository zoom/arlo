import React, { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';

const ZoomSdkContext = createContext();
const SDK_PROBE_TIMEOUT_MS = 4000;

const isForcedBrowserMode = () => window.location.search.includes('test=true');

// Legacy export for backwards compatibility
export const isTestMode = isForcedBrowserMode();

export function probeZoomSdk(zoomSdk, timeoutMs = SDK_PROBE_TIMEOUT_MS) {
  if (!zoomSdk?.config) {
    return Promise.reject(new Error('Zoom Apps SDK is unavailable'));
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Zoom Apps SDK configuration timed out'));
    }, timeoutMs);

    Promise.resolve().then(() => zoomSdk.config({
      capabilities: [
        'getMeetingContext',
        'getMeetingUUID',
        'getRunningContext',
        'getUserContext',
        'getMeetingParticipants',
        'authorize',
        'onAuthorized',
        'promptAuthorize',
        'startRTMS',
        'stopRTMS',
        'pauseRTMS',
        'resumeRTMS',
        'showNotification',
        'sendMessageToChat',
        'openUrl',
        'onRunningContextChange',
        'onMyUserContextChange',
        'sendAppInvitationToAllParticipants',
        'sendAppInvitation',
        'showAppInvitationDialog',
        'onSendAppInvitation',
      ],
      version: '0.16.0',
    })).then(
      response => {
        clearTimeout(timeoutId);
        resolve(response);
      },
      error => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export async function getZoomUserContext(zoomSdk, runningContext) {
  if (runningContext !== 'inMeeting') {
    return null;
  }

  return zoomSdk.getUserContext();
}

export function ZoomSdkProvider({ children }) {
  const forcedBrowserMode = isForcedBrowserMode();
  const [environment, setEnvironment] = useState(forcedBrowserMode ? 'browser' : 'detecting');
  const [sdkConfigured, setSdkConfigured] = useState(false);
  const [sdkError, setSdkError] = useState(null);
  const [runningContext, setRunningContext] = useState(forcedBrowserMode ? 'test' : null);
  const [meetingContext, setMeetingContext] = useState(null);
  const [userContext, setUserContext] = useState(null);
  // null = SDK not loaded yet, true = guest, false = authorized user
  const [isGuest, setIsGuest] = useState(forcedBrowserMode ? false : null);
  const initializationStarted = useRef(false);

  useEffect(() => {
    if (forcedBrowserMode || initializationStarted.current) {
      return;
    }
    initializationStarted.current = true;

    const zoomSdk = window.zoomSdk;

    function applyBrowserFallback(error) {
      if (error) {
        console.info('Zoom Apps SDK unavailable; using browser mode:', error.message);
      }
      setEnvironment('browser');
      setSdkConfigured(false);
      setSdkError(null);
      setRunningContext('browser');
      setMeetingContext(null);
      setUserContext(null);
      setIsGuest(false);
    }

    async function configureSdk() {
      let configuredInZoom = false;

      try {
        const configResponse = await probeZoomSdk(zoomSdk);
        configuredInZoom = true;

        console.log('SDK Configured:', configResponse);
        setEnvironment('zoom');
        setSdkConfigured(true);

        // Get running context
        const contextResponse = await zoomSdk.getRunningContext();
        const context = contextResponse.context || contextResponse;
        setRunningContext(context);

        async function refreshUserContext(activeContext) {
          if (activeContext !== 'inMeeting') {
            setUserContext(null);
            setIsGuest(false);
            return;
          }

          try {
            const user = await getZoomUserContext(zoomSdk, activeContext);
            setUserContext(user);
            setIsGuest(user?.status !== 'authorized');
          } catch (err) {
            console.warn('getUserContext failed (may be guest):', err);
            setUserContext({ status: 'unauthenticated' });
            setIsGuest(true);
          }
        }

        await refreshUserContext(context);

        async function fetchMeetingContext() {
          let data = {};
          let meetingUUID = null;

          try {
            const uuidResponse = await zoomSdk.getMeetingUUID();
            if (uuidResponse) {
              meetingUUID = uuidResponse?.meetingUUID ||
                uuidResponse?.uuid ||
                (typeof uuidResponse === 'string' ? uuidResponse : null);
            }
          } catch (uuidErr) {
            console.error('getMeetingUUID failed:', uuidErr);
          }

          try {
            const meeting = await zoomSdk.getMeetingContext();
            if (!meetingUUID && meeting) {
              meetingUUID = meeting.meetingUUID || meeting.meetingId || meeting.uuid || meeting.id;
            }
            data = { ...data, ...meeting };
            if (meeting?.meetingID) {
              data.meetingID = meeting.meetingID;
            }
          } catch {
            // Could not get meeting context
          }

          if (meetingUUID) {
            data.meetingUUID = meetingUUID;
          }

          return data;
        }

        // Get meeting context (if in meeting)
        if (context === 'inMeeting') {
          const meetingData = await fetchMeetingContext();
          setMeetingContext(meetingData);
        }

        // Listen for context changes (e.g. user joins/leaves a meeting)
        zoomSdk.onRunningContextChange(async (event) => {
          const newContext = event.runningContext;
          setRunningContext(newContext);
          if (newContext === 'inMeeting') {
            await refreshUserContext(newContext);
            const meetingData = await fetchMeetingContext();
            setMeetingContext(meetingData);
          } else {
            await refreshUserContext(newContext);
            setMeetingContext(null);
          }
        });

        // Listen for user context changes (e.g. guest → authorized after promptAuthorize)
        zoomSdk.onMyUserContextChange(async (event) => {
          const newStatus = event.status;
          console.log('User context changed:', newStatus);
          setUserContext(prev => ({ ...prev, ...event }));
          setIsGuest(newStatus !== 'authorized');

          // When user becomes authorized, re-configure SDK and fetch meeting context
          if (newStatus === 'authorized') {
            try {
              await zoomSdk.config({
                capabilities: [
                  'getMeetingContext', 'getMeetingUUID', 'getRunningContext',
                  'getUserContext', 'getMeetingParticipants', 'authorize',
                  'onAuthorized', 'promptAuthorize', 'startRTMS',
                  'stopRTMS', 'pauseRTMS', 'resumeRTMS',
                  'showNotification',
                  'sendMessageToChat', 'openUrl', 'onRunningContextChange',
                  'onMyUserContextChange', 'sendAppInvitationToAllParticipants',
                  'sendAppInvitation', 'showAppInvitationDialog', 'onSendAppInvitation',
                ],
                version: '0.16.0',
              });
            } catch (err) {
              console.warn('Re-config after elevation failed:', err);
            }

            if (context === 'inMeeting') {
              try {
                const meetingData = await fetchMeetingContext();
                setMeetingContext(meetingData);
              } catch (err) {
                console.warn('Meeting context refresh after authorization failed:', err);
              }
            }
          }
        });
      } catch (error) {
        if (!configuredInZoom) {
          applyBrowserFallback(error);
          return;
        }

        console.error('SDK Configuration Error:', error);
        setSdkError(error.message);
        setRunningContext('error');
        setIsGuest(false);
      }
    }

    configureSdk();
  }, [forcedBrowserMode]);

  const zoomSdk = environment === 'zoom' ? window.zoomSdk : null;
  const isTestModeState = environment === 'browser';

  const contextValue = useMemo(() => ({
    zoomSdk,
    sdkConfigured,
    sdkError,
    runningContext,
    meetingContext,
    userContext,
    userContextStatus: userContext?.status || null,
    isGuest,
    isTestMode: isTestModeState,
  }), [zoomSdk, sdkConfigured, sdkError, runningContext, meetingContext, userContext, isGuest, isTestModeState]);

  return (
    <ZoomSdkContext.Provider value={contextValue}>
      {children}
    </ZoomSdkContext.Provider>
  );
}

export function useZoomSdk() {
  const context = useContext(ZoomSdkContext);
  if (!context) {
    throw new Error('useZoomSdk must be used within a ZoomSdkProvider');
  }
  return context;
}
