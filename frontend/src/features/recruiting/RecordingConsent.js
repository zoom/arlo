import React, { useState, useEffect } from 'react';
import { Shield, X, Check, AlertCircle, StopCircle } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import './RecordingConsent.css';

/**
 * RecordingConsent — BrightHire-style recording consent banner and controls.
 *
 * RTMS does not trigger Zoom's native recording indicator. This component
 * provides visible notification that recording is active, plus controls for
 * candidates or interviewers to pause or stop recording.
 *
 * Features:
 * - Consent notification banner when recording starts
 * - Dismissible after acknowledgment
 * - Stop/pause controls accessible to all participants
 * - Persistent "recording active" indicator
 */

const CONSENT_STORAGE_KEY = 'arlo-recruiting-consent-ack';

export default function RecordingConsent({
  isRecording,
  isPaused,
  onStop,
  onPause,
  onResume,
  meetingId,
  candidateName,
  showDemoData = true,
}) {
  const [showBanner, setShowBanner] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  // Check if user has already acknowledged for this meeting
  useEffect(() => {
    if (!isRecording) {
      setShowBanner(false);
      setAcknowledged(false);
      return;
    }

    const stored = sessionStorage.getItem(`${CONSENT_STORAGE_KEY}-${meetingId}`);
    if (stored) {
      setAcknowledged(true);
      setShowBanner(false);
    } else {
      setShowBanner(true);
    }
  }, [isRecording, meetingId]);

  const handleAcknowledge = () => {
    sessionStorage.setItem(`${CONSENT_STORAGE_KEY}-${meetingId}`, 'true');
    setAcknowledged(true);
    setShowBanner(false);
  };

  const handleStopRecording = () => {
    setShowStopConfirm(true);
  };

  const confirmStop = () => {
    onStop?.();
    setShowStopConfirm(false);
  };

  // Full-screen consent banner (shown before acknowledgment)
  if (showBanner && !acknowledged) {
    return (
      <div className="consent-overlay">
        <Card className="consent-banner">
          <div className="consent-banner-content">
            <div className="consent-icon-container">
              <Shield size={32} className="consent-icon" />
            </div>

            <h2 className="text-serif text-xl font-medium">This Interview is Being Recorded</h2>

            <p className="consent-description text-sans text-sm text-muted">
              This interview session is being recorded and transcribed by Arlo to help the hiring
              team review and make better decisions. The recording will be stored securely and
              only shared with the interview panel.
            </p>

            <div className="consent-details">
              <div className="consent-detail-item">
                <Check size={14} className="consent-check" />
                <span className="text-sans text-sm">Audio and transcript captured</span>
              </div>
              <div className="consent-detail-item">
                <Check size={14} className="consent-check" />
                <span className="text-sans text-sm">Visible to hiring team only</span>
              </div>
              <div className="consent-detail-item">
                <Check size={14} className="consent-check" />
                <span className="text-sans text-sm">You can request deletion at any time</span>
              </div>
            </div>

            <div className="consent-actions">
              <Button onClick={handleAcknowledge} className="consent-acknowledge-btn">
                <Check size={16} />
                I Understand
              </Button>
              <button
                className="consent-stop-link text-sans text-sm"
                onClick={handleStopRecording}
              >
                Request to stop recording
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Stop confirmation modal
  if (showStopConfirm) {
    return (
      <div className="consent-overlay">
        <Card className="consent-confirm-modal">
          <div className="consent-confirm-content">
            <AlertCircle size={24} className="consent-alert-icon" />
            <h3 className="text-serif font-medium">Stop Recording?</h3>
            <p className="text-sans text-sm text-muted">
              This will permanently stop the recording for this interview. The hiring team
              will not be able to review this portion of the conversation.
            </p>
            <div className="consent-confirm-actions">
              <Button variant="outline" onClick={() => setShowStopConfirm(false)}>
                Cancel
              </Button>
              <Button className="btn-destructive" onClick={confirmStop}>
                <StopCircle size={16} />
                Stop Recording
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Compact recording indicator (shown after acknowledgment)
  if (isRecording && acknowledged) {
    return (
      <Card className="consent-indicator">
        <div className="consent-indicator-content">
          <div className="consent-indicator-status">
            <div className={`consent-recording-dot ${isPaused ? 'paused' : 'active'}`}>
              <div className="consent-recording-dot-inner" />
              {!isPaused && <div className="consent-recording-dot-ping" />}
            </div>
            <span className="text-sans text-sm">
              {isPaused ? 'Recording Paused' : 'Recording Active'}
            </span>
          </div>

          <div className="consent-indicator-controls">
            {isPaused ? (
              <Button variant="outline" size="sm" onClick={onResume}>
                Resume
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onPause}>
                Pause
              </Button>
            )}
            <button
              className="consent-stop-btn"
              onClick={handleStopRecording}
              title="Stop recording"
            >
              <StopCircle size={16} />
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return null;
}
