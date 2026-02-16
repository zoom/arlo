import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Sparkles, Bookmark, Check, Minus } from 'lucide-react';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import OwlIcon from '../components/OwlIcon';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import './GuestNoMeetingView.css';

const COMPARISON = [
  { feature: 'Live transcript', guest: true, full: true },
  { feature: 'Meeting summary', guest: true, full: true },
  { feature: 'AI chat & questions', guest: false, full: true },
  { feature: 'Highlights & bookmarks', guest: false, full: true },
  { feature: 'Meeting history', guest: false, full: true },
  { feature: 'Full-text search', guest: false, full: true },
  { feature: 'Start/stop recording', guest: false, full: true },
];

export default function GuestNoMeetingView() {
  const navigate = useNavigate();
  const { zoomSdk, userContextStatus, meetingContext, runningContext, isTestMode } = useZoomSdk();

  const handleInstall = () => {
    if (!isTestMode && zoomSdk?.promptAuthorize) {
      zoomSdk.promptAuthorize().catch(() => {});
    }
  };

  const handleContinueAsGuest = () => {
    const inMeeting = runningContext === 'inMeeting';
    const meetingUUID = meetingContext?.meetingUUID;
    if (inMeeting && meetingUUID) {
      navigate(`/guest/${encodeURIComponent(meetingUUID)}`);
    }
  };

  const ctaLabel = userContextStatus === 'unauthenticated'
    ? 'Sign in to Zoom'
    : 'Add Arlo to Your Account';

  const inMeeting = runningContext === 'inMeeting' && meetingContext?.meetingUUID;

  return (
    <div className="guest-no-meeting">
      <div className="guest-content">
        <OwlIcon size={64} />

        <div className="guest-heading">
          <h1 className="text-serif text-2xl">
            You've been invited to use Arlo
          </h1>
          <p className="text-sans text-sm text-muted">
            Your AI meeting assistant — follow along in real time
          </p>
        </div>

        {/* What is Arlo */}
        <Card className="guest-what-card">
          <p className="text-serif text-sm" style={{ lineHeight: 1.7 }}>
            Arlo captures meeting transcripts in real time using Zoom's built-in
            streaming — no bots, no downloads. It generates summaries, tracks
            action items, and lets you search across everything.
          </p>
        </Card>

        {/* Feature cards */}
        <div className="guest-features">
          <Card>
            <div className="guest-feature-inner">
              <Mic size={20} className="guest-feature-icon" />
              <div className="guest-feature-text">
                <h3 className="text-sans font-medium">Live Transcript</h3>
                <p className="text-sans text-sm text-muted">
                  Follow along with a real-time transcript. See who said what, with timestamps.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="guest-feature-inner">
              <Sparkles size={20} className="guest-feature-icon" />
              <div className="guest-feature-text">
                <h3 className="text-sans font-medium">AI Summaries</h3>
                <p className="text-sans text-sm text-muted">
                  Key takeaways, decisions, and action items — generated as the meeting progresses.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="guest-feature-inner">
              <Bookmark size={20} className="guest-feature-icon" />
              <div className="guest-feature-text">
                <h3 className="text-sans font-medium">Highlights</h3>
                <p className="text-sans text-sm text-muted">
                  View moments the host has bookmarked as important.
                </p>
              </div>
            </div>
          </Card>
        </div>

        {/* Comparison table */}
        <table className="guest-comparison-table">
          <thead>
            <tr>
              <th className="text-sans text-xs text-muted">Feature</th>
              <th className="text-sans text-xs text-muted">Guest</th>
              <th className="text-sans text-xs text-muted">Full Access</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON.map((row) => (
              <tr key={row.feature}>
                <td className="text-sans text-sm">{row.feature}</td>
                <td>
                  {row.guest
                    ? <Check size={14} className="guest-check-icon" />
                    : <Minus size={14} className="guest-dash-icon" />
                  }
                </td>
                <td>
                  {row.full
                    ? <Check size={14} className="guest-check-icon" />
                    : <Minus size={14} className="guest-dash-icon" />
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* CTA buttons */}
        <div className="guest-cta-row">
          <Button size="lg" className="guest-btn" onClick={handleInstall}>
            {ctaLabel}
          </Button>
          {inMeeting && (
            <Button variant="ghost" size="lg" className="guest-btn" onClick={handleContinueAsGuest}>
              Continue as guest
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
