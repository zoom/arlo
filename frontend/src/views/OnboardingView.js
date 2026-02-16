import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Loader2, Calendar, Repeat } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import OwlIcon from '../components/OwlIcon';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import './OnboardingView.css';

export default function OnboardingView() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, user } = useAuth();
  const { addToast } = useToast();
  const isFirst = searchParams.get('first') === 'true';

  const [meetings, setMeetings] = useState([]);
  const [loadingMeetings, setLoadingMeetings] = useState(true);
  const [autoOpenStates, setAutoOpenStates] = useState({});

  useEffect(() => {
    if (!isAuthenticated) return;
    async function fetchMeetings() {
      try {
        const res = await fetch('/api/zoom-meetings', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const list = (data.meetings || []).slice(0, 5);
          setMeetings(list);
          const initial = {};
          list.forEach((m) => { initial[m.id] = m.autoOpenEnabled || false; });
          setAutoOpenStates(initial);
        }
      } catch {
        // no-op — empty state will show
      } finally {
        setLoadingMeetings(false);
      }
    }
    fetchMeetings();
  }, [isAuthenticated]);

  const toggleAutoOpen = useCallback(async (meetingId) => {
    const wasEnabled = autoOpenStates[meetingId];
    setAutoOpenStates((prev) => ({ ...prev, [meetingId]: !prev[meetingId] }));
    try {
      await fetch(`/api/zoom-meetings/${meetingId}/auto-open`, {
        method: wasEnabled ? 'DELETE' : 'POST',
        credentials: 'include',
      });
    } catch {
      // keep optimistic state
    }
  }, [autoOpenStates]);

  const enableAll = useCallback(async () => {
    const toEnable = meetings.filter((m) => !autoOpenStates[m.id]);
    if (toEnable.length === 0) return;
    const allEnabled = {};
    meetings.forEach((m) => { allEnabled[m.id] = true; });
    setAutoOpenStates(allEnabled);
    for (const m of toEnable) {
      try {
        await fetch(`/api/zoom-meetings/${m.id}/auto-open`, {
          method: 'POST',
          credentials: 'include',
        });
      } catch {
        // continue
      }
    }
    addToast('Auto-open enabled for all meetings');
  }, [meetings, autoOpenStates, addToast]);

  const formatMeetingTime = (dateStr, duration) => {
    const date = new Date(dateStr);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const startTime = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const endDate = new Date(date.getTime() + duration * 60000);
    const endTime = endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${dayName}, ${monthDay} · ${startTime} – ${endTime}`;
  };

  // OAuth callback loading state
  if (isLoading) {
    return (
      <div className="onboarding-view">
        <div className="onboarding-loading">
          <OwlIcon size={48} className="onboarding-owl" />
          <div className="onboarding-loading-row">
            <Loader2 size={20} className="onboarding-spinner" />
            <p className="text-sans text-muted">Connecting to Zoom...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="onboarding-view">
        <div className="onboarding-loading">
          <OwlIcon size={48} className="onboarding-owl" />
          <p className="text-sans text-muted">Session expired. Please install again.</p>
          <Button variant="default" onClick={() => navigate('/')}>
            Go to Home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-view">
      <div className="onboarding-content">
        {/* Success Icon */}
        <div className="onboarding-icon-wrapper">
          <div className="onboarding-check-circle">
            <CheckCircle2 size={40} className="onboarding-check-icon" />
          </div>
        </div>

        {/* Heading */}
        <div className="onboarding-heading">
          <h1 className="text-serif onboarding-title">
            {isFirst ? 'Welcome to Arlo!' : 'Welcome back!'}
          </h1>
          <p className="text-sans text-muted">
            {isFirst
              ? `Successfully connected to Zoom${user?.displayName ? ` as ${user.displayName}` : ''}!`
              : `Good to see you again${user?.displayName ? `, ${user.displayName}` : ''}.`}
          </p>
        </div>

        {/* Upcoming Meetings Section */}
        <section className="onboarding-meetings-section">
          <div className="onboarding-meetings-header">
            <h2 className="text-serif onboarding-meetings-title">Your upcoming meetings</h2>
            <p className="text-sans text-sm text-muted">
              Enable auto-open so Arlo launches when these meetings start
            </p>
          </div>

          {/* Loading skeleton */}
          {loadingMeetings && (
            <div className="onboarding-meetings-list">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="onboarding-meeting-card">
                  <div className="onboarding-meeting-inner">
                    <div className="onboarding-meeting-content">
                      <div className="onboarding-skeleton onboarding-skeleton-title" />
                      <div className="onboarding-skeleton onboarding-skeleton-date" />
                    </div>
                    <div className="onboarding-skeleton onboarding-skeleton-toggle" />
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Meeting cards */}
          {!loadingMeetings && meetings.length > 0 && (
            <>
              <div className="onboarding-meetings-list">
                {meetings.map((meeting) => (
                  <Card
                    key={meeting.id}
                    className="onboarding-meeting-card onboarding-meeting-card-interactive"
                    onClick={() => toggleAutoOpen(meeting.id)}
                  >
                    <div className="onboarding-meeting-inner">
                      <div className="onboarding-meeting-content">
                        <div className="onboarding-meeting-title-row">
                          <p className="text-serif text-sm font-medium">
                            {meeting.title}
                          </p>
                          {autoOpenStates[meeting.id] && (
                            <Badge className="onboarding-auto-badge">Auto-open</Badge>
                          )}
                        </div>
                        <p className="text-sans text-xs text-muted">
                          {formatMeetingTime(meeting.date, meeting.duration)}
                        </p>
                        {meeting.isRecurring && (
                          <div className="onboarding-recurring-row">
                            <Repeat size={12} />
                            <span className="text-sans text-xs">Recurring</span>
                          </div>
                        )}
                      </div>

                      <div
                        className="onboarding-toggle-col"
                        onClick={(e) => { e.stopPropagation(); toggleAutoOpen(meeting.id); }}
                      >
                        <label className="settings-toggle">
                          <input
                            type="checkbox"
                            checked={autoOpenStates[meeting.id] || false}
                            onChange={() => toggleAutoOpen(meeting.id)}
                          />
                          <span className="settings-toggle-track" />
                          <span className="settings-toggle-thumb" />
                        </label>
                        <span className="text-sans onboarding-toggle-label">Auto-open</span>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <div className="onboarding-enable-all-row">
                <button onClick={enableAll} className="text-sans onboarding-enable-all">
                  Enable all
                </button>
              </div>
            </>
          )}

          {/* Empty state */}
          {!loadingMeetings && meetings.length === 0 && (
            <Card>
              <div className="onboarding-meetings-empty">
                <Calendar size={24} className="text-muted" />
                <p className="text-serif text-sm text-muted">No upcoming meetings scheduled</p>
                <p className="text-sans text-xs text-muted">
                  Meetings will appear here once they're on your Zoom calendar
                </p>
              </div>
            </Card>
          )}
        </section>

        {/* Simplified Tip Card */}
        <Card className="onboarding-tip-card">
          <div className="onboarding-tip-inner">
            <div className="onboarding-tip-icon">
              <OwlIcon size={32} />
            </div>
            <p className="text-sans text-sm text-muted onboarding-tip-text">
              Arlo will auto-open in meetings you've enabled above. You can also manually open Arlo from the Apps button in any Zoom meeting toolbar.
            </p>
          </div>
        </Card>

        {/* Actions */}
        <div className="onboarding-actions">
          <Button
            variant="default"
            size="lg"
            className="onboarding-open-zoom"
            onClick={() => { window.open('https://zoom.us', '_blank'); }}
          >
            Open Zoom <ExternalLink size={16} />
          </Button>

          <p className="text-sans text-sm text-muted" style={{ textAlign: 'center' }}>
            Need help?{' '}
            <a href="https://github.com/anthropics/arlo-meeting-assistant" target="_blank" rel="noopener noreferrer">
              Visit our documentation
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
