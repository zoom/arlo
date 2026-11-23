import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMeeting } from '../contexts/MeetingContext';
import { useArlo } from '../contexts/ArloContext';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { useServerSettings } from '../contexts/ServerSettingsContext';
import useZoomAuth from '../hooks/useZoomAuth';
import useSecondsLeft from '../hooks/useSecondsLeft';
import { getArloScreen, canControlArlo } from '../lib/arloScreen';
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
    rtmsPhase, rtmsLoading, rtmsError, rtmsWaitingLong, rtmsRequestExpiresAt, startRTMS,
  } = useMeeting();
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
  });
  const canControl = canControlArlo({ guest, arloRole: arlo.role });

  // Out of a meeting there is nothing to show, except the notes of the one that just ended
  const outsideMeeting = !isGuestMode && !isTestMode && runningContext !== null && runningContext !== 'inMeeting';
  const nothingToShow = outsideMeeting && screen !== 'after';
  useEffect(() => {
    if (nothingToShow) navigate('/home', { replace: true });
  }, [nothingToShow, navigate]);

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
  useEffect(() => {
    if (arloRole !== 'owner' || pendingChoiceRef.current === null) return;
    const choice = pendingChoiceRef.current;
    pendingChoiceRef.current = null;
    if (choice !== whoCanAsk) setWhoCanAsk(choice);
  }, [arloRole, whoCanAsk, setWhoCanAsk]);

  const bringArloIn = useCallback(() => {
    if (arloRole === 'owner') {
      if (whoCanAskChoice !== whoCanAsk) setWhoCanAsk(whoCanAskChoice);
    } else {
      pendingChoiceRef.current = whoCanAskChoice;
    }
    startRTMS(false);
  }, [arloRole, whoCanAsk, whoCanAskChoice, setWhoCanAsk, startRTMS]);

  const signIn = useCallback(() => {
    // The reason is shown next to the button; nothing else to do with it here
    authorize().catch(() => {});
  }, [authorize]);

  // The title outlives the meeting context, which Zoom clears when the meeting is left
  const titleRef = useRef(null);
  if (meetingContext?.meetingTopic) titleRef.current = meetingContext.meetingTopic;
  const recordId = encodeURIComponent(meetingId || routeId || '');
  const recordPath = `${isGuestMode ? '/guest-meeting' : '/meeting'}/${recordId}/record`;

  if (nothingToShow) return null;

  if (accessHidesScreen(meetingAccess) && screen !== 'after') {
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

  // The existing wording for a request that failed, was declined or ran out
  const transport = getTransportView({
    phase: rtmsPhase, active: false, paused: false, waitingLong: rtmsWaitingLong, secondsLeft, error: rtmsError, guest,
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
          <div className="arlo-waiting" role="status" aria-live="polite">
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
          canControl={canControl}
          recordPath={recordPath}
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
      content = (
        <ParticipantView
          present={present}
          ownerName={arlo.ownerName}
          whoCanAsk={arlo.whoCanAsk}
          guest={guest}
          meetingEnded={meetingEnded}
          showRecord={present || arlo.everPresent}
          recordPath={recordPath}
          onSignIn={signIn}
          signingIn={isAuthorizing}
          signInError={signInError ? 'Could not sign in. Try again.' : null}
        />
      );
      break;
    }
    default:
      content = <div className="arlo-center"><LoadingSpinner size={24} /></div>;
  }

  return (
    <div className="arlo-view" data-screen={screen}>
      {content}
    </div>
  );
}
