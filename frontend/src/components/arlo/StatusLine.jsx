import React, { useEffect, useState } from 'react';
import { useMeeting } from '../../contexts/MeetingContext';
import { getTransportView } from '../../lib/transportView';
import Button from '../ui/Button';

const LABELS = {
  live: 'Arlo is in the meeting',
  paused: 'Arlo is paused',
  reconnecting: 'Reconnecting…',
  left: 'Arlo has left',
};
// How long "Remove Arlo?" waits for the second click
const CONFIRM_MS = 5000;

/** The confirmed stream phase first; what the server says about Arlo otherwise. */
function arloStatus({ phase, present, paused }) {
  if (phase === 'interrupted') return 'reconnecting';
  if (phase === 'paused') return 'paused';
  if (phase === 'active') return 'live';
  if (present) return paused ? 'paused' : 'live';
  return 'left';
}

/**
 * Where Arlo is, and the few things that can be done about it. The actions
 * are for people who may control Arlo (lib/arloScreen.js canControlArlo);
 * everyone else sees the status only. Each action is a request: the label
 * changes when Zoom confirms it.
 */
export default function StatusLine({ present, paused, canControl }) {
  const {
    rtmsPhase, rtmsActive, rtmsPaused, rtmsLoading, rtmsError,
    startRTMS, stopRTMS, pauseRTMS, resumeRTMS,
  } = useMeeting();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const status = arloStatus({ phase: rtmsPhase, present, paused });
  // The existing wording for a failed control or a stream fault
  const { message } = getTransportView({
    phase: rtmsPhase, active: rtmsActive, paused: rtmsPaused, hasContent: true, error: rtmsError, guest: !canControl,
  });

  useEffect(() => {
    if (!confirmingRemove) return undefined;
    const timer = setTimeout(() => setConfirmingRemove(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmingRemove]);
  useEffect(() => {
    if (status === 'left') setConfirmingRemove(false);
  }, [status]);

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
              <Button variant="ghost" size="sm" onClick={() => resumeRTMS()} disabled={rtmsLoading}>Resume</Button>
            )}
            {status !== 'left' && (
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
