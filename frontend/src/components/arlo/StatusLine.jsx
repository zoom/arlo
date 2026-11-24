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
  // Here through another person's stream; this owner's own has stopped
  others: 'Arlo is in the meeting',
};
const THINKING = 'Arlo is thinking…';
// Arlo is in the meeting: the statuses in which it can be handling a request
const CAN_THINK = new Set(['live', 'paused', 'reconnecting', 'others']);
const OTHERS_LINE = 'Your own Arlo has stopped. Notes continue from another person\'s.';
// A stream that exists: the only statuses with Pause, Resume or Remove
const IN_MEETING = new Set(['live', 'paused', 'reconnecting']);
// This panel's phases of a stream that runs
const RUNNING_PHASES = new Set(['active', 'paused', 'interrupted']);
// How long "Remove Arlo?" waits for the second click
const CONFIRM_MS = 5000;

/**
 * A request first (it is not a state, and says so), then the confirmed stream
 * phase; what the server says about Arlo otherwise.
 */
function arloStatus({ phase, present, paused, myStreamPaused, ownLive, canControl, waitingOnHost }) {
  if (phase === 'requested') return waitingOnHost ? 'asking' : 'returning';
  if (phase === 'starting') return 'returning';
  // An owner whose own stream has stopped while another person's keeps Arlo in
  // the meeting: nothing here is theirs to pause or remove. Whatever that
  // other stream does (a pause, a reconnect), their one action is the same.
  if (canControl && present && !ownLive) return 'others';
  if (phase === 'interrupted') return 'reconnecting';
  // Several people can each run a stream in one meeting. An owner's line is
  // about their OWN stream (`myStreamPaused`), because Resume acts on it:
  // another owner's pause, or the meeting-level `paused`, must not offer it.
  // Someone who controls nothing reads the meeting-level `paused`, for the
  // wording only.
  // The server and this panel can disagree for a while (a pause this client
  // was never told about, or one the server has not reported yet): paused
  // when either says so, so Resume is always within reach.
  const pausedOnServer = canControl ? myStreamPaused : paused;
  if (phase === 'paused' || (pausedOnServer && (present || phase === 'active'))) return 'paused';
  if (phase === 'active' || present) return 'live';
  return 'left';
}

/**
 * Where Arlo is, and the few things that can be done about it. The actions
 * are for an owner only (lib/arloScreen.js canControlArlo): they act on the
 * caller's own stream. Each action is a request: the label
 * changes when Zoom confirms it.
 *
 * `paused`: every live stream in the meeting is paused. `myStreamPaused`: this
 * person's own stream is. `myStreamLive`: the server's word on whether this
 * person's own stream runs; when it did not say (null), this panel's phase
 * decides. Pause, Resume and Remove are for a stream of one's own that runs.
 * `thinking`: Arlo is handling a request (ArloContext `thinking`): until it
 * is done the label says what Arlo is doing (`thinkingStep`, a sentence from
 * the server, already read as untrusted input and rendered as text), or
 * "Arlo is thinking…" when the server did not say. The section is marked
 * `data-thinking` meanwhile, and `data-heard` when the request was said in
 * the meeting (`thinkingChannel` 'voice'): the dot and the label move by
 * those marks, in CSS only (views/ArloMeetingView.css), and stand still for
 * someone who asked for reduced motion.
 */
export default function StatusLine({
  present, paused, myStreamPaused = false, myStreamLive = null, canControl, thinking = false,
  thinkingStep = null, thinkingChannel = null,
}) {
  const {
    rtmsPhase, rtmsActive, rtmsPaused, rtmsLoading, rtmsError, rtmsWaitingLong,
    startRTMS, stopRTMS, pauseRTMS, resumeRTMS,
  } = useMeeting();
  const { userContext } = useZoomSdk();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // The host's own request needs nobody's permission
  const waitingOnHost = userContext?.role !== 'host';
  const ownLive = typeof myStreamLive === 'boolean' ? myStreamLive : RUNNING_PHASES.has(rtmsPhase);
  const status = arloStatus({
    phase: rtmsPhase, present, paused, myStreamPaused, ownLive, canControl, waitingOnHost,
  });
  const inMeeting = IN_MEETING.has(status);
  // While Arlo handles a request the line says so; the actions stay those of the status
  const showThinking = thinking === true && CAN_THINK.has(status);
  const thinkingLabel = typeof thinkingStep === 'string' && thinkingStep.length > 0 ? thinkingStep : THINKING;
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
    <section
      className="arlo-status"
      data-status={status}
      data-thinking={showThinking ? 'true' : undefined}
      data-heard={showThinking && thinkingChannel === 'voice' ? 'true' : undefined}
      aria-label="Arlo"
    >
      <div className="arlo-status-row">
        <div className="arlo-status-label" role="status" aria-live="polite">
          <span className="arlo-dot" aria-hidden="true" />
          <span className="arlo-status-text">{showThinking ? thinkingLabel : LABELS[status]}</span>
        </div>
        {canControl && (
          <div className="arlo-status-actions">
            {status === 'live' && (
              <Button variant="ghost" size="sm" onClick={() => pauseRTMS()} disabled={rtmsLoading}>Pause</Button>
            )}
            {status === 'paused' && (
              <Button variant="ghost" size="sm" onClick={() => resumeRTMS({ pausedOnServer: myStreamPaused })} disabled={rtmsLoading}>Resume</Button>
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
            {(status === 'left' || status === 'others') && (
              <Button variant="outline" size="sm" onClick={() => startRTMS(false)} disabled={rtmsLoading}>
                Bring Arlo back
              </Button>
            )}
          </div>
        )}
      </div>
      {canControl && status === 'others' && <p className="arlo-muted arlo-status-note">{OTHERS_LINE}</p>}
      {message && <p className="arlo-error" role="alert">{message}</p>}
    </section>
  );
}
