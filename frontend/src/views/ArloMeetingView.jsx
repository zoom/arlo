import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMeeting } from '../contexts/MeetingContext';
import { useArlo } from '../contexts/ArloContext';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { useServerSettings } from '../contexts/ServerSettingsContext';
import { useToast } from '../contexts/ToastContext';
import useZoomAuth from '../hooks/useZoomAuth';
import useSecondsLeft from '../hooks/useSecondsLeft';
import { getArloScreen, canControlArlo, canBringArloIn } from '../lib/arloScreen';
import { getTransportView } from '../lib/transportView';
import { accessHidesScreen } from '../lib/meetingAccess';
import MeetingAccessNotice from '../components/MeetingAccessNotice';
import Button from '../components/ui/Button';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import BringArloIn from '../components/arlo/BringArloIn';
import AskHost from '../components/arlo/AskHost';
import LiveNotes from '../components/arlo/LiveNotes';
import ParticipantView from '../components/arlo/ParticipantView';
import AfterMeeting from '../components/arlo/AfterMeeting';
import './ArloMeetingView.css';

const FALLBACK_TITLE = 'Meeting notes';
const STILL_IN_FORCE = { owner: 'Only you', anyone: 'Anyone' };

/** Text is being typed into this element (a radio or a button is not typing). */
function isTextEntry(element) {
  if (!element || element === document.body || !element.isConnected) return false;
  if (element.tagName === 'TEXTAREA' || element.isContentEditable) return true;
  return element.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'reset'].includes(element.type);
}

/**
 * Arlo in a meeting: one screen at a time, chosen by lib/arloScreen.js from
 * confirmed state. No tabs, no dashboard.
 *
 * Zoom's Dynamic Indicator needs nothing here: MeetingProvider keeps it in
 * step with the stream on every screen (hooks/useDynamicIndicator.js).
 */
export default function ArloMeetingView({ isGuestMode = false }) {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const {
    ws, meetingId, meetingAccess, connectWebSocket,
    rtmsPhase, rtmsLoading, rtmsError, rtmsWaitingLong, rtmsRequestExpiresAt, startRTMS, startAskedHere,
  } = useMeeting();
  const { addToast } = useToast();
  const arlo = useArlo();
  const { isAuthenticated } = useAuth();
  const { meetingContext, userContext, isTestMode, runningContext } = useZoomSdk();
  const { demoMode } = useServerSettings();
  const { authorize, isAuthorizing, error: signInError } = useZoomAuth();
  const secondsLeft = useSecondsLeft(rtmsRequestExpiresAt);

  // Signed in to Arlo or not, whichever route opened the screen
  const guest = !isAuthenticated;
  const zoomRole = userContext?.role;
  // Over for this panel: Zoom said the meeting ended, or this person left it
  const meetingEnded = arlo.meetingOver;
  const screen = getArloScreen({
    guest,
    zoomRole,
    arloRole: arlo.role,
    present: arlo.present,
    phase: rtmsPhase,
    meetingEnded,
    hasNotes: arlo.notes !== null,
    everPresent: arlo.everPresent,
    streamFault: rtmsPhase === 'stopped' && rtmsError?.code === 'stream_fault',
    // This panel asked, the stream is up, and the server has not said yet whose it is
    awaitingRole: startAskedHere && arlo.awaitingState,
    notesPending: arlo.notesPending,
  });
  const canControl = canControlArlo({ guest, arloRole: arlo.role });

  // Out of a meeting there is nothing to show, except the notes of the one that
  // just ended. A guest goes to the guest screen for no meeting.
  const outsideMeeting = !isTestMode && runningContext !== null && runningContext !== 'inMeeting';
  const nothingToShow = outsideMeeting && screen !== 'after';
  const leaveTo = guest ? '/guest' : '/home';
  useEffect(() => {
    if (nothingToShow) navigate(leaveTo, { replace: true });
  }, [nothingToShow, leaveTo, navigate]);

  // Another meeting than the one in the address (the panel stayed open on the
  // notes of the last one): the address follows the meeting
  useEffect(() => {
    if (!meetingId || !routeId || routeId === meetingId) return;
    navigate(`${isGuestMode ? '/guest-meeting' : '/meeting'}/${encodeURIComponent(meetingId)}`, { replace: true });
  }, [meetingId, routeId, isGuestMode, navigate]);

  // The meeting socket: signed-in people and guests alike; access is the verified meeting
  useEffect(() => {
    if (ws || !meetingId) return;
    if (isGuestMode || isAuthenticated) connectWebSocket(meetingId);
  }, [isGuestMode, isAuthenticated, ws, meetingId, connectWebSocket]);

  // A guest who signs in gets a socket that knows who they are
  const wasAuthenticatedRef = useRef(isAuthenticated);
  useEffect(() => {
    const signedInNow = isAuthenticated && !wasAuthenticatedRef.current;
    wasAuthenticatedRef.current = isAuthenticated;
    if (signedInNow && ws && meetingId) connectWebSocket(meetingId);
  }, [isAuthenticated, ws, meetingId, connectWebSocket]);

  // "Who can ask Arlo", chosen before Arlo is here. Only an owner may set it,
  // so it is sent when the server says this person is one.
  const [whoCanAskChoice, setWhoCanAskChoice] = useState('owner');
  const pendingChoiceRef = useRef(null);
  const { role: arloRole, whoCanAsk, setWhoCanAsk } = arlo;
  const whoCanAskRef = useRef(whoCanAsk);
  whoCanAskRef.current = whoCanAsk;
  // A choice that was not saved is never silent: say so, and which setting still holds
  const saveWhoCanAsk = useCallback(async (value) => {
    const saved = await setWhoCanAsk(value);
    if (!saved) {
      const inForce = STILL_IN_FORCE[whoCanAskRef.current] || STILL_IN_FORCE.owner;
      addToast(`Couldn't change who can ask. It is still: ${inForce}.`, 'error');
    }
    return saved;
  }, [setWhoCanAsk, addToast]);
  useEffect(() => {
    if (arloRole !== 'owner' || pendingChoiceRef.current === null) return;
    const choice = pendingChoiceRef.current;
    pendingChoiceRef.current = null;
    if (choice !== whoCanAsk) saveWhoCanAsk(choice);
  }, [arloRole, whoCanAsk, saveWhoCanAsk]);

  const bringArloIn = useCallback(() => {
    if (arloRole === 'owner') {
      if (whoCanAskChoice !== whoCanAsk) saveWhoCanAsk(whoCanAskChoice);
    } else {
      pendingChoiceRef.current = whoCanAskChoice;
    }
    startRTMS(false);
  }, [arloRole, whoCanAsk, whoCanAskChoice, saveWhoCanAsk, startRTMS]);

  const signIn = useCallback(() => {
    // The reason is shown next to the button; nothing else to do with it here
    authorize().catch(() => {});
  }, [authorize]);

  // The title outlives the meeting context, which Zoom clears when the meeting is left
  const titleRef = useRef(null);
  if (meetingContext?.meetingTopic) titleRef.current = meetingContext.meetingTopic;
  const recordId = encodeURIComponent(meetingId || routeId || '');
  const recordPath = `${isGuestMode ? '/guest-meeting' : '/meeting'}/${recordId}/record`;

  // A new screen takes the focus to its heading, so it is not left on <body>
  // when what had it is gone. Never from an input the user is typing in that
  // is still there (the header's search, for one).
  const accessNotice = accessHidesScreen(meetingAccess) && screen !== 'after';
  const viewRef = useRef(null);
  const focusedScreenRef = useRef(null);
  useEffect(() => {
    if (nothingToShow || accessNotice || focusedScreenRef.current === screen) return;
    const target = viewRef.current?.querySelector('[data-arlo-focus]');
    if (!target) return;
    focusedScreenRef.current = screen;
    if (isTextEntry(document.activeElement)) return;
    target.focus();
  }, [screen, nothingToShow, accessNotice]);

  if (nothingToShow) return null;

  if (accessNotice) {
    return (
      <div className="arlo-view">
        {meetingAccess.status === 'idle' ? (
          <div className="arlo-center"><LoadingSpinner size={24} /></div>
        ) : (
          <MeetingAccessNotice
            access={meetingAccess}
            isGuestMode={isGuestMode}
            onRetry={() => connectWebSocket(meetingId)}
          />
        )}
      </div>
    );
  }

  // Why a request failed, was declined or ran out, in these screens' words
  const transport = getTransportView({
    phase: rtmsPhase, active: false, paused: false, waitingLong: rtmsWaitingLong, secondsLeft, error: rtmsError, guest,
    wording: 'arlo',
  });

  let content;
  switch (screen) {
    case 'bring-in':
      content = (
        <BringArloIn
          whoCanAsk={whoCanAskChoice}
          onWhoCanAskChange={setWhoCanAskChoice}
          onBringIn={bringArloIn}
          disabled={rtmsLoading}
          message={transport.message}
        />
      );
      break;
    case 'ask-host':
      content = <AskHost onAsk={() => startRTMS(false)} disabled={rtmsLoading} message={transport.message} />;
      break;
    case 'waiting': {
      // The host's own request needs nobody's permission
      const waitingOnHost = rtmsPhase === 'requested' && zoomRole !== 'host';
      content = (
        <div className="arlo-center">
          <div className="arlo-waiting" role="status" aria-live="polite" tabIndex={-1} data-arlo-focus>
            <span className="arlo-waiting-spinner" aria-hidden="true"><LoadingSpinner size={16} /></span>
            <span>
              {waitingOnHost
                ? `Waiting for the host to allow Arlo…${secondsLeft !== null ? ` ${secondsLeft}s` : ''}`
                : 'Bringing Arlo in…'}
            </span>
          </div>
          {transport.hint && <p className="arlo-muted">{transport.hint}</p>}
          {transport.actions.includes('start') && (
            <Button variant="outline" size="sm" onClick={() => startRTMS(false)}>Try again</Button>
          )}
          {transport.message && <p className="arlo-error" role="alert">{transport.message}</p>}
        </div>
      );
      break;
    }
    case 'notes':
      content = (
        <LiveNotes
          notes={arlo.notes}
          present={arlo.present === true}
          paused={arlo.paused}
          myStreamPaused={arlo.myStreamPaused}
          myStreamLive={arlo.myStreamLive}
          canControl={canControl}
          recordPath={recordPath}
          whoCanAsk={arlo.whoCanAsk}
          onWhoCanAskChange={saveWhoCanAsk}
        />
      );
      break;
    case 'after':
      content = (
        <AfterMeeting
          title={titleRef.current || FALLBACK_TITLE}
          notes={arlo.notes}
          demoMode={demoMode}
          recordPath={recordPath}
        />
      );
      break;
    case 'participant': {
      // The stream is confirmed for this panel, or the server says Arlo is here
      const present = !meetingEnded
        && (arlo.present === true || rtmsPhase === 'active' || rtmsPhase === 'paused' || rtmsPhase === 'interrupted');
      // "Use Arlo yourself": this person's own request, shown where they clicked.
      // The host's own request needs nobody's permission.
      const ownProgress = rtmsPhase === 'requested'
        ? (zoomRole === 'host' ? 'starting' : 'asking')
        : (rtmsPhase === 'starting' ? 'starting' : null);
      const ownStart = {
        progress: ownProgress,
        secondsLeft,
        hint: ownProgress === 'asking' ? transport.hint : null,
        // Zoom does not say when the host allows Arlo: after a while they may ask again
        mayAskAgain: ownProgress === 'asking' && transport.actions.includes('start'),
        message: transport.message,
      };
      content = (
        <ParticipantView
          present={present}
          paused={arlo.paused}
          ownerName={arlo.ownerName}
          whoCanAsk={arlo.whoCanAsk}
          guest={guest}
          canBringIn={canBringArloIn(zoomRole)}
          meetingEnded={meetingEnded}
          showRecord={present || arlo.everPresent}
          recordPath={recordPath}
          onSignIn={signIn}
          signingIn={isAuthorizing}
          signInError={signInError ? 'Could not sign in. Try again.' : null}
          ownStart={ownStart}
          onUseArlo={() => startRTMS(false)}
          useArloDisabled={rtmsLoading}
        />
      );
      break;
    }
    default:
      content = <div className="arlo-center"><LoadingSpinner size={24} /></div>;
  }

  return (
    <div className="arlo-view" data-screen={screen} ref={viewRef}>
      {content}
    </div>
  );
}
