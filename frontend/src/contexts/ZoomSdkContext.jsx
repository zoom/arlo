import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const ZoomSdkContext = createContext();

// Capabilities required for auth, RTMS, and in-meeting flows.
const CORE_CAPABILITIES = [
  'getAppContext', // signed context the backend verifies to grant meeting-scoped transcript access
  'getMeetingContext',
  'getMeetingUUID',
  'getRunningContext',
  'getUserContext',
  'authorize',
  'onAuthorized',
  'promptAuthorize',
  'callZoomApi',
  'showNotification',
  'sendMessageToChat',
  'openUrl',
  'onRunningContextChange',
  'onMyUserContextChange',
];

// Collaboration and invitation APIs vary by Zoom client; request separately so we can fall back.
const OPTIONAL_CAPABILITIES = [
  'getMeetingParticipants',
  'onMessage',
  'postMessage',
  'sendAppInvitationToAllParticipants',
  'sendAppInvitation',
  'showAppInvitationDialog',
  'onSendAppInvitation',
  'startCollaborate',
  'endCollaborate',
  'joinCollaborate',
  'leaveCollaborate',
  'onCollaborateChange',
  'runRenderingContext',
];

// The documented RTMS APIs: controls plus session status (connecting/started/paused/stopped).
// Requested on their own so an app whose Marketplace config doesn't list them yet, or an
// older client, keeps the optional APIs above. Desktop only: start/stop need client 6.4.10,
// pause/resume/getRTMSStatus 6.5.5, onRTMSStatusChange 6.5.10. None support guest mode.
const RTMS_STATUS_CAPABILITIES = [
  'startRTMS',
  'stopRTMS',
  'pauseRTMS',
  'resumeRTMS',
  'getRTMSStatus',
  'onRTMSStatusChange',
];

// Check if running outside Zoom - evaluated dynamically
const checkIsTestMode = () => !window.zoomSdk || window.location.search.includes('test=true');

// Legacy export for backwards compatibility
export const isTestMode = checkIsTestMode();

export function ZoomSdkProvider({ children }) {
  // Use state for isTestMode so it can update after SDK loads
  const initialTestMode = checkIsTestMode();
  console.log('ZoomSdkProvider init:', {
    initialTestMode,
    zoomSdkAvailable: !!window.zoomSdk,
    hasTestParam: window.location.search.includes('test=true')
  });

  const [isTestModeState, setIsTestModeState] = useState(initialTestMode);
  const [sdkConfigured, setSdkConfigured] = useState(initialTestMode);
  const [sdkError, setSdkError] = useState(null);
  const [runningContext, setRunningContext] = useState(initialTestMode ? 'test' : null);
  const [meetingContext, setMeetingContext] = useState(null);
  const [userContext, setUserContext] = useState(null);
  // true once zoomSdk.config() accepted getRTMSStatus + onRTMSStatusChange
  const [rtmsStatusSupported, setRtmsStatusSupported] = useState(false);
  // null = SDK not loaded yet, true = guest, false = authorized user
  const [isGuest, setIsGuest] = useState(initialTestMode ? false : null);

  useEffect(() => {
    // Re-check if SDK is available now (might have loaded after initial render)
    const sdkAvailable = !!window.zoomSdk;
    const testModeNow = !sdkAvailable || window.location.search.includes('test=true');

    console.log('useEffect check:', { testModeNow, isTestModeState, sdkAvailable });
    if (!testModeNow && isTestModeState) {
      // SDK became available - update state
      console.log('SDK detected after initial render - updating isTestModeState to false');
      setIsTestModeState(false);
    }

    if (testModeNow) {
      console.log('Running in test mode (outside Zoom)');
      return;
    }

    const zoomSdk = window.zoomSdk;

    async function configureSdk() {
      try {
        // Some Zoom clients reject config when unsupported capabilities are requested.
        // Try the largest set first, then fall back step by step to the core set.
        const capabilitySets = [
          [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES, ...RTMS_STATUS_CAPABILITIES],
          [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES],
          CORE_CAPABILITIES,
        ];
        let configResponse;
        let acceptedCapabilities = null;
        for (let i = 0; i < capabilitySets.length; i += 1) {
          try {
            configResponse = await zoomSdk.config({
              capabilities: capabilitySets[i],
              version: '0.16.0',
            });
            acceptedCapabilities = capabilitySets[i];
            break;
          } catch (configError) {
            if (i === capabilitySets.length - 1) throw configError;
            console.warn('Capability set rejected, retrying with a smaller set:', configError);
          }
        }

        console.log('SDK Configured:', configResponse);
        const rtmsApisAccepted = acceptedCapabilities.includes('onRTMSStatusChange');
        // If this prints false, the client sends Arlo no RTMS status at all
        console.log('RTMS SDK APIs (start/stop/pause/resume/status) accepted by this client:', rtmsApisAccepted);
        setRtmsStatusSupported(rtmsApisAccepted);
        setSdkConfigured(true);
        setIsTestModeState(false); // Definitely not in test mode if SDK configured

        // Get running context
        const contextResponse = await zoomSdk.getRunningContext();
        const context = contextResponse.context || contextResponse;
        setRunningContext(context);

        // Get user context
        let user = null;
        try {
          user = await zoomSdk.getUserContext();
          setUserContext(user);
        } catch (err) {
          console.warn('getUserContext failed (may be guest):', err);
          setUserContext({ status: 'unauthenticated' });
        }

        // Derive guest status: authorized = not guest, anything else = guest
        const userStatus = user?.status;
        setIsGuest(userStatus !== 'authorized');

        async function fetchMeetingContext() {
          let data = {};
          let meetingUUID = null;
          let meetingID = null;

          try {
            const uuidResponse = await zoomSdk.getMeetingUUID();
            console.log('getMeetingUUID answered:', !!uuidResponse);
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
            // Not logged: the response holds the meeting topic and ids
            if (!meetingUUID && meeting) {
              meetingUUID = meeting.meetingUUID || meeting.meetingId || meeting.uuid || meeting.id;
            }
            // Also capture numeric meeting ID as fallback
            meetingID = meeting?.meetingID || meeting?.meetingId || meeting?.id;
            data = { ...data, ...meeting };
          } catch (ctxErr) {
            console.error('getMeetingContext failed:', ctxErr);
          }

          if (meetingUUID) {
            data.meetingUUID = meetingUUID;
          }
          if (meetingID) {
            data.meetingID = meetingID;
          }

          // Use meetingID as fallback if no UUID available
          if (!data.meetingUUID && data.meetingID) {
            console.log('Using the numeric meeting ID as fallback identifier');
            data.meetingUUID = String(data.meetingID);
          }

          console.log('Meeting context ready:', { hasMeetingUUID: !!data.meetingUUID });
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
            const meetingData = await fetchMeetingContext();
            setMeetingContext(meetingData);
          } else {
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
              // Same set the client accepted at startup (keeps RTMS status events).
              await zoomSdk.config({
                capabilities: acceptedCapabilities,
                version: '0.16.0',
              });
            } catch (err) {
              console.warn('Re-config after elevation failed:', err);
            }
          }
        });
      } catch (error) {
        console.error('SDK Configuration Error:', error);
        setSdkError(error.message);
        // Prevent infinite loading states if SDK setup fails.
        setRunningContext('error');
        // Route as non-guest so RootView sends the user to /auth (web OAuth fallback).
        setIsGuest(false);
      }
    }

    configureSdk();
  }, [isTestModeState]);

  // Get current SDK reference for context value
  const zoomSdk = window.zoomSdk;

  const contextValue = useMemo(() => ({
    zoomSdk,
    sdkConfigured,
    sdkError,
    runningContext,
    meetingContext,
    userContext,
    userContextStatus: userContext?.status || null,
    isGuest,
    rtmsStatusSupported,
    isTestMode: isTestModeState,
  }), [zoomSdk, sdkConfigured, sdkError, runningContext, meetingContext, userContext, isGuest, rtmsStatusSupported, isTestModeState]);

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
