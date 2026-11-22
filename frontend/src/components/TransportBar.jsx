import React from 'react';
import { Pause, Play, Square, Mic } from 'lucide-react';
import { useMeeting } from '../contexts/MeetingContext';
import useSecondsLeft from '../hooks/useSecondsLeft';
import { getTransportView } from '../lib/transportView';
import Button from './ui/Button';
import LoadingSpinner from './ui/LoadingSpinner';
import './TransportBar.css';

/**
 * The one place transcription is shown and controlled: status on the left,
 * controls on the right, the reason underneath when something went wrong.
 * `extra` is a slot for secondary actions (share / invite).
 */
export default function TransportBar({ guest = false, hasContent = false, extra = null }) {
  const {
    rtmsPhase, rtmsActive, rtmsPaused, rtmsLoading, rtmsWaitingLong, rtmsRequestExpiresAt, rtmsError,
    startRTMS, stopRTMS, pauseRTMS, resumeRTMS,
  } = useMeeting();
  const secondsLeft = useSecondsLeft(rtmsRequestExpiresAt);

  const view = getTransportView({
    phase: rtmsPhase,
    active: rtmsActive,
    paused: rtmsPaused,
    hasContent,
    waitingLong: rtmsWaitingLong,
    secondsLeft,
    error: rtmsError,
    guest,
  });
  const has = (action) => view.actions.includes(action);
  // While waiting on the host, Start is the way out, so it stays enabled.
  const startDisabled = rtmsLoading && view.state !== 'requesting';

  return (
    <section className="transport-bar" data-state={view.state} aria-label="Transcription">
      <div className="transport-bar-row">
        <div className="transport-status" role="status" aria-live="polite">
          {view.indicator === 'spinner' && <LoadingSpinner size={14} />}
          {view.indicator === 'live' && (
            <span className="transport-dot" data-pulse="true" aria-hidden="true" />
          )}
          {view.indicator === 'paused' && <span className="transport-dot" data-paused="true" aria-hidden="true" />}
          <span className="transport-label text-sans text-sm">{view.label}</span>
        </div>

        <div className="transport-actions">
          {has('start') && (
            <Button
              size="sm"
              variant={view.state === 'requesting' ? 'outline' : 'default'}
              onClick={() => startRTMS(false)}
              disabled={startDisabled}
              aria-label={view.startLabel}
            >
              <Mic size={14} aria-hidden="true" />
              {view.startLabel === 'Try again' ? 'Try again' : 'Start'}
            </Button>
          )}
          {has('pause') && (
            <Button variant="outline" size="sm" onClick={() => pauseRTMS()} disabled={rtmsLoading} aria-label="Pause transcription">
              <Pause size={14} aria-hidden="true" />
              <span className="transport-action-text">Pause</span>
            </Button>
          )}
          {has('resume') && (
            <Button size="sm" onClick={() => resumeRTMS()} disabled={rtmsLoading} aria-label="Resume transcription">
              <Play size={14} aria-hidden="true" />
              <span className="transport-action-text">Resume</span>
            </Button>
          )}
          {has('stop') && (
            <Button
              variant="outline"
              size="sm"
              className="btn-destructive-outline"
              onClick={() => stopRTMS()}
              disabled={rtmsLoading}
              aria-label="Stop transcription"
            >
              <Square size={14} aria-hidden="true" />
              <span className="transport-action-text">Stop</span>
            </Button>
          )}
          {extra}
        </div>
      </div>

      {view.hint && <p className="transport-hint text-sans text-xs">{view.hint}</p>}
      {view.message && <p className="transport-message text-sans text-xs" role="alert">{view.message}</p>}
    </section>
  );
}
