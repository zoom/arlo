import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import Button from './ui/Button';
import LoadingSpinner from './ui/LoadingSpinner';
import './MeetingAccessNotice.css';

/**
 * Shows whether the server has confirmed (via the signed Zoom App Context)
 * that this viewer is in the meeting. Guests see why they can read the live
 * transcript; anyone who fails verification gets the reason and a retry.
 */
export default function MeetingAccessNotice({ access, isGuestMode, onRetry }) {
  const { status, reason } = access || {};

  if (status === 'verifying') {
    return (
      <div className="meeting-access-notice" role="status">
        <LoadingSpinner size={14} />
        <span>Confirming you're in this meeting…</span>
      </div>
    );
  }

  if (status === 'verified' && isGuestMode) {
    return (
      <div className="meeting-access-notice meeting-access-notice--ok" role="status">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>Verified meeting participant. You're seeing what Arlo captures in this meeting.</span>
      </div>
    );
  }

  if (status === 'denied' || status === 'unavailable') {
    return (
      <div className="meeting-access-notice meeting-access-notice--error" role="alert">
        <ShieldAlert size={14} aria-hidden="true" />
        <span>{reason || 'Could not verify your meeting.'}</span>
        {status === 'denied' && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        )}
      </div>
    );
  }

  return null;
}
