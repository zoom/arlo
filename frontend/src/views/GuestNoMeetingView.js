import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import OwlIcon from '../components/OwlIcon';
import Button from '../components/ui/Button';
import './GuestNoMeetingView.css';

export default function GuestNoMeetingView() {
  const navigate = useNavigate();
  const { zoomSdk, userContextStatus, meetingContext, runningContext, isTestMode } = useZoomSdk();

  // Auto-redirect to full meeting view when meeting ID becomes available
  useEffect(() => {
    const inMeeting = runningContext === 'inMeeting';
    const meetingUUID = meetingContext?.meetingUUID;
    const meetingID = meetingContext?.meetingID;
    const routeId = meetingUUID || meetingID;

    console.log('GuestNoMeetingView: checking redirect', { inMeeting, meetingUUID, meetingID, routeId });

    if (inMeeting && routeId) {
      console.log('GuestNoMeetingView: redirecting to full view with ID:', routeId);
      navigate(`/guest-meeting/${encodeURIComponent(routeId)}`, { replace: true });
    }
  }, [runningContext, meetingContext, navigate]);

  const handleInstall = () => {
    if (!isTestMode && zoomSdk?.promptAuthorize) {
      zoomSdk.promptAuthorize().catch(() => {});
    }
  };

  const handleContinueAsGuest = () => {
    const inMeeting = runningContext === 'inMeeting';
    const routeId = meetingContext?.meetingUUID || meetingContext?.meetingID;
    if (inMeeting && routeId) {
      navigate(`/guest-meeting/${encodeURIComponent(routeId)}`);
    }
  };

  const ctaLabel = userContextStatus === 'unauthenticated'
    ? 'Sign in with Zoom'
    : 'Add Arlo to Your Account';

  const inMeeting = runningContext === 'inMeeting' && (meetingContext?.meetingUUID || meetingContext?.meetingID);

  return (
    <div className="guest-no-meeting">
      <div className="guest-content">
        <OwlIcon size={64} />

        <div className="guest-heading">
          <h1 className="text-serif text-2xl">Arlo</h1>
          <p className="text-sans text-muted guest-tagline">
            Real-time meeting transcription & AI insights
          </p>
        </div>

        {/* CTA buttons - prominent placement */}
        <div className="guest-cta-stack">
          <Button size="lg" className="guest-btn-primary" onClick={handleInstall}>
            {ctaLabel}
          </Button>

          {inMeeting && (
            <button className="guest-link-btn" onClick={handleContinueAsGuest}>
              Continue as guest →
            </button>
          )}
        </div>

        {/* Brief feature list */}
        <div className="guest-features-brief">
          <p className="text-sans text-sm text-muted">
            <strong>Full access includes:</strong> AI summaries, searchable history,
            highlights & bookmarks, meeting chat with your transcripts.
          </p>
        </div>
      </div>
    </div>
  );
}
