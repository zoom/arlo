import React, { useEffect, useState } from 'react';
import { useMeeting } from '../../contexts/MeetingContext';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { getTransportView } from '../../lib/transportView';
import Button from '../ui/Button';

const LABELS = {
  live: 'Arlo is in the meeting',
  paused: 'Arlo is paused',
  reconnecting: 'Reconnecting…',
  returning: 'Bringing Arlo back…',
  asking: 'Waiting for the host to allow Arlo…',
  left: 'Arlo has left',
};
// A stream that exists: the only statuses with Pause, Resume or Remove
const IN_MEETING = new Set(['live', 'paused', 'reconnecting']);
// How long "Remove Arlo?" waits for the second click
const CONFIRM_MS = 5000;

/**
 * A request first (it is not a state, and says so), then the confirmed stream
 * phase; what the server says about Arlo otherwise.
 */
function arloStatus({ phase, present, paused, waitingOnHost }) {
  if (phase === 'requested') return waitingOnHost ? 'asking' : 'returning';
  if (phase === 'starting') return 'returning';
  if (phase === 'interrupted') return 'reconnecting';
  // The server and this panel can disagree for a while (a pause this client
  // was never told about, or one the server has not reported yet): paused
  // when either says so, so Resume is always within reach.
  if (phase === 'paused' || (paused && (present || phase === 'active'))) return 'paused';
  if (phase === 'active' || present) return 'live';
  return 'left';
}

/**
 * Where Arlo is, and the few things that can be done about it. The actions
 * are for an owner only (lib/arloScreen.js canControlArlo): they act on the
 * caller's own stream. Each action is a request: the label
 * changes when Zoom confirms it.
 */
export default function StatusLine({ present, paused, canControl }) {
  const {
    rtmsPhase, rtmsActive, rtmsPaused, rtmsLoading, rtmsError, rtmsWaitingLong,
    startRTMS, stopRTMS, pauseRTMS, resumeRTMS,
  } = useMeeting();
  const { userContext } = useZoomSdk();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // The host's own request needs nobody's permission
  const waitingOnHost = userContext?.role !== 'host';
  const status = arloStatus({ phase: rtmsPhase, present, paused, waitingOnHost });
  const inMeeting = IN_MEETING.has(status);
  // Why a control failed or the stream ended, in this screen's words
  const { message } = getTransportView({
    phase: rtmsPhase, active: rtmsActive, paused: rtmsPaused, hasContent: true, error: rtmsError, guest: !canControl,
    wording: 'arlo',
  });
  // Zoom does not say when the host allows Arlo: after a while the owner may ask again
  const mayAskAgain = rtmsPhase === 'requested' && rtmsWaitingLong;

  useEffect(() => {
    if (!confirmingRemove) return undefined;
    const timer = setTimeout(() => setConfirmingRemove(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmingRemove]);
  useEffect(() => {
    if (!inMeeting) setConfirmingRemove(false);
  }, [inMeeting]);

  const remove = () => {
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setConfirmingRemove(false);
    stopRTMS();
  };

  return (
    <section className="arlo-status" data-status={status} aria-label="Arlo">
      <div className="arlo-status-row">
        <div className="arlo-status-label" role="status" aria-live="polite">
          <span className="arlo-dot" aria-hidden="true" />
          <span>{LABELS[status]}</span>
        </div>
        {canControl && (
          <div className="arlo-status-actions">
            {status === 'live' && (
              <Button variant="ghost" size="sm" onClick={() => pauseRTMS()} disabled={rtmsLoading}>Pause</Button>
            )}
            {status === 'paused' && (
              <Button variant="ghost" size="sm" onClick={() => resumeRTMS({ pausedOnServer: paused })} disabled={rtmsLoading}>Resume</Button>
            )}
            {inMeeting && (
              <Button
                variant="ghost"
                size="sm"
                className={confirmingRemove ? 'arlo-remove-confirm' : ''}
                onClick={remove}
                disabled={rtmsLoading}
              >
                {confirmingRemove ? 'Remove Arlo?' : 'Remove Arlo'}
              </Button>
            )}
            {mayAskAgain && (
              <Button variant="outline" size="sm" onClick={() => startRTMS(false)}>Try again</Button>
            )}
            {status === 'left' && (
              <Button variant="outline" size="sm" onClick={() => startRTMS(false)} disabled={rtmsLoading}>
                Bring Arlo back
              </Button>
            )}
          </div>
        )}
      </div>
      {message && <p className="arlo-error" role="alert">{message}</p>}
    </section>
  );
}
