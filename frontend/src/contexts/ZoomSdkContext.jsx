import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { resolveUserStatus } from '../lib/userStatus';

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

// Dynamic Indicator: Arlo's status in Zoom's own meeting window, visible to all
// participants. Requested on its own for the same reason. Desktop 5.17.5+.
const DYNAMIC_INDICATOR_CAPABILITIES = [
  'setDynamicIndicator',
  'removeDynamicIndicator',
];

// The waiting room: who is in it, and letting one person in. Arlo does this when
// asked ("Arlo, let James in"), through the panel of an owner who is the host or
// a co-host (lib/arloActions.js). Requested on its own for the same reason.
// Desktop 5.15.10+; Zoom allows both to the host and co-hosts only.
const WAITING_ROOM_CAPABILITIES = [
  'getWaitingRoomParticipants',
  'admitParticipantFromWaitingRoom',
];

// Muting someone: Arlo does it when asked ("Arlo, mute Danny Lee"), through the
// panel of an owner who is the host or a co-host (lib/arloActions.js), with
// getMeetingParticipants from the optional set above to find the person.
// Desktop 5.10.3+; Zoom allows both to the host and co-hosts only.
const PARTICIPANT_AUDIO_CAPABILITIES = [
  'toggleParticipantMediaAudio',
];

// Reactions: Arlo sends one as the owner whose panel it is. Only what is
// called is asked for: an API in this list that a client or the app's
// configuration refuses takes the whole tier with it. Desktop 5.14.5+.
const REACTION_CAPABILITIES = [
  'setEmojiReaction',
];

// The share dialog: after Arlo opened a ticket in the browser ("Arlo, open
// PROJ-123 and share it"), the owner's panel brings up Zoom's share dialog and
// the owner picks the window (lib/arloActions.js). Only promptShareScreen is
// called, so only it is asked for. Desktop 5.13.5, older than the reactions
// (5.14.5), so it is asked for in the reactions' tier and not in one of its
// own: no config attempt more.
const SHARE_SCREEN_CAPABILITIES = [
  'promptShareScreen',
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
  // "Accepted" below: asked for in the set Zoom took, and not in the answer's `unsupportedApis`
  // true once zoomSdk.config() accepted getRTMSStatus + onRTMSStatusChange
  const [rtmsStatusSupported, setRtmsStatusSupported] = useState(false);
  // true once zoomSdk.config() accepted setDynamicIndicator + removeDynamicIndicator
  const [dynamicIndicatorSupported, setDynamicIndicatorSupported] = useState(false);
  // true once zoomSdk.config() accepted sendMessageToChat and the client has the method
  const [chatSupported, setChatSupported] = useState(false);
  // true once zoomSdk.config() accepted the waiting-room APIs and the client has the methods
  const [waitingRoomSupported, setWaitingRoomSupported] = useState(false);
  // The same for sendAppInvitationToAllParticipants, for setEmojiReaction, and for
  // toggleParticipantMediaAudio with getMeetingParticipants
  const [invitationSupported, setInvitationSupported] = useState(false);
  const [reactionSupported, setReactionSupported] = useState(false);
  const [muteSupported, setMuteSupported] = useState(false);
  // The same for openUrl (in the core set) and for promptShareScreen
  const [openUrlSupported, setOpenUrlSupported] = useState(false);
  const [shareScreenSupported, setShareScreenSupported] = useState(false);
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
        // Each step drops the tier added last, so a client (or a Marketplace
        // configuration) that lacks the newest keeps everything it had before.
        // Every step is one more config attempt: seven at most.
        const upToWaitingRoom = [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES, ...RTMS_STATUS_CAPABILITIES, ...DYNAMIC_INDICATOR_CAPABILITIES, ...WAITING_ROOM_CAPABILITIES];
        const capabilitySets = [
          [...upToWaitingRoom, ...PARTICIPANT_AUDIO_CAPABILITIES, ...REACTION_CAPABILITIES, ...SHARE_SCREEN_CAPABILITIES],
          [...upToWaitingRoom, ...PARTICIPANT_AUDIO_CAPABILITIES],
          upToWaitingRoom,
          [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES, ...RTMS_STATUS_CAPABILITIES, ...DYNAMIC_INDICATOR_CAPABILITIES],
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
            if (capabilitySets[i].includes('setDynamicIndicator') && !capabilitySets[i].includes('getWaitingRoomParticipants')) {
              console.warn('[indicator] Zoom rejected the Dynamic Indicator APIs at config:', configError?.code, configError?.message);
            }
          }
        }

        console.log('SDK Configured:', configResponse);
        // Zoom can accept the configuration and still say it lacks some of the
        // APIs asked for (ConfigResponse `unsupportedApis`, a list of API
        // names): those are not there, whatever the client object has.
        const unsupportedApis = new Set(
          (Array.isArray(configResponse?.unsupportedApis) ? configResponse.unsupportedApis : [])
            .filter((name) => typeof name === 'string'),
        );
        /** Asked for, accepted, and not listed as unsupported. */
        const granted = (name) => acceptedCapabilities.includes(name) && !unsupportedApis.has(name);
        const rtmsApisAccepted = granted('onRTMSStatusChange') && granted('getRTMSStatus');
        // If this prints false, the client sends Arlo no RTMS status at all
        console.log('RTMS SDK APIs (start/stop/pause/resume/status) accepted by this client:', rtmsApisAccepted);
        setRtmsStatusSupported(rtmsApisAccepted);
        const indicatorAccepted = granted('setDynamicIndicator') && granted('removeDynamicIndicator')
          && typeof zoomSdk.setDynamicIndicator === 'function'
          && typeof zoomSdk.removeDynamicIndicator === 'function';
        console.log('[indicator] APIs accepted by this client:', indicatorAccepted, {
          requested: acceptedCapabilities.includes('setDynamicIndicator'),
          granted: granted('setDynamicIndicator') && granted('removeDynamicIndicator'),
          setMethod: typeof zoomSdk.setDynamicIndicator,
          removeMethod: typeof zoomSdk.removeDynamicIndicator,
        });
        setDynamicIndicatorSupported(indicatorAccepted);
        setChatSupported(granted('sendMessageToChat') && typeof zoomSdk.sendMessageToChat === 'function');
        setWaitingRoomSupported(WAITING_ROOM_CAPABILITIES.every((name) => (
          granted(name) && typeof zoomSdk[name] === 'function'
        )));
        /** Granted, and the client object has the method. */
        const usable = (name) => granted(name) && typeof zoomSdk[name] === 'function';
        setInvitationSupported(usable('sendAppInvitationToAllParticipants'));
        setReactionSupported(usable('setEmojiReaction'));
        setMuteSupported(usable('toggleParticipantMediaAudio') && usable('getMeetingParticipants'));
        setOpenUrlSupported(usable('openUrl'));
        setShareScreenSupported(usable('promptShareScreen'));
        setSdkConfigured(true);
        setIsTestModeState(false); // Definitely not in test mode if SDK configured

        // Get running context
        const contextResponse = await zoomSdk.getRunningContext();
        const context = contextResponse.context || contextResponse;
        setRunningContext(context);

        // Get user context. Guest mode only exists in a meeting; outside one the
        // person opened their own app and is never a guest (lib/userStatus.js).
        let user = null;
        try {
          user = await zoomSdk.getUserContext();
        } catch (err) {
          console.warn('getUserContext failed:', err?.message || err);
        }
        const resolved = resolveUserStatus({ runningContext: context, reported: user?.status || null });
        setUserContext({ ...(user || {}), status: resolved.status });
        setIsGuest(resolved.isGuest);

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
          const current = await zoomSdk.getRunningContext().catch(() => null);
          const resolvedNow = resolveUserStatus({
            runningContext: current?.context || current || context,
            reported: newStatus || null,
          });
          setUserContext(prev => ({ ...prev, ...event, status: resolvedNow.status }));
          setIsGuest(resolvedNow.isGuest);

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
    dynamicIndicatorSupported,
    chatSupported,
    waitingRoomSupported,
    invitationSupported,
    reactionSupported,
    muteSupported,
    openUrlSupported,
    shareScreenSupported,
    isTestMode: isTestModeState,
  }), [openUrlSupported, shareScreenSupported, invitationSupported, reactionSupported, muteSupported, waitingRoomSupported, zoomSdk, sdkConfigured, sdkError, runningContext, meetingContext, userContext, isGuest, rtmsStatusSupported, dynamicIndicatorSupported, chatSupported, isTestModeState]);

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
