import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { ScrollArea } from '@base-ui/react';
import { Sparkles, ChevronDown, ArrowDown, X, Lock, LogIn, LogOut, Mic, MicOff, Pause, Play, Eye } from 'lucide-react';
import { useMeeting } from '../contexts/MeetingContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import OwlIcon from '../components/OwlIcon';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import './GuestInMeetingView.css';

function formatTimestamp(ms) {
  const date = new Date(Number(ms));
  if (isNaN(date.getTime()) || ms === 0) return '--:--';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function InlineEventIcon({ eventType }) {
  const cls = "transcript-event-icon";
  switch (eventType) {
    case 'joined': return <LogIn size={14} className={cls} />;
    case 'left': return <LogOut size={14} className={cls} />;
    case 'transcription_started': return <Mic size={14} className={cls} />;
    case 'transcription_stopped': return <MicOff size={14} className={cls} />;
    case 'transcription_paused': return <Pause size={14} className={cls} />;
    case 'transcription_resumed': return <Play size={14} className={cls} />;
    default: return <Mic size={14} className={cls} />;
  }
}

function InlineEventLabel({ eventType, name }) {
  switch (eventType) {
    case 'joined': return `${name} joined the meeting`;
    case 'left': return `${name} left the meeting`;
    case 'transcription_started': return 'Transcription started';
    case 'transcription_stopped': return 'Transcription stopped';
    case 'transcription_paused': return 'Transcription paused';
    case 'transcription_resumed': return 'Transcription resumed';
    default: return `${name} — ${eventType}`;
  }
}

export default function GuestInMeetingView() {
  const { id } = useParams();
  const { zoomSdk, meetingContext, userContextStatus, isTestMode } = useZoomSdk();
  const { ws, connectWebSocket, rtmsActive, viewers } = useMeeting();

  // Meeting ID: prefer SDK context, fall back to URL param
  const meetingId = meetingContext?.meetingUUID || id;

  const [meeting, setMeeting] = useState(null);
  const [segments, setSegments] = useState([]);
  const [participantEvents, setParticipantEvents] = useState([]);
  const [meetingEnded, setMeetingEnded] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const [ctaDismissed, setCtaDismissed] = useState(() => sessionStorage.getItem('guest-cta-dismissed') === 'true');
  const [loading, setLoading] = useState(true);
  const transcriptRef = useRef(null);
  const historicalLoadedRef = useRef(false);

  // Fetch meeting details (title, summary) from backend
  useEffect(() => {
    if (!meetingId) return;
    fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.meeting) {
          setMeeting(data.meeting);
          if (data.meeting.status === 'completed') {
            setMeetingEnded(true);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [meetingId]);

  // Connect WebSocket for live transcript (anonymous — null token)
  useEffect(() => {
    if (!meetingId || ws) return;
    connectWebSocket(null, meetingId);
  }, [meetingId, ws, connectWebSocket]);

  // Load historical transcript segments
  useEffect(() => {
    if (!meetingId || historicalLoadedRef.current) return;
    historicalLoadedRef.current = true;

    fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/transcript`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.segments?.length > 0) {
          setSegments(prev => {
            const dbSeqs = new Set(data.segments.map(s => s.seqNo));
            const newFromWs = prev.filter(s => !dbSeqs.has(String(s.seqNo)));
            return [...data.segments, ...newFromWs];
          });
        }
      })
      .catch(() => {});

    // Also load participant events
    fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/participant-events`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.events?.length > 0) {
          setParticipantEvents(prev => {
            const dbIds = new Set(data.events.map(e => e.id));
            const newFromWs = prev.filter(e => !dbIds.has(e.id));
            return [...data.events, ...newFromWs];
          });
        }
      })
      .catch(() => {});
  }, [meetingId]);

  // Listen for WebSocket messages
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'transcript.segment') {
        const { segment } = message.data;
        setSegments(prev => [...prev, segment]);

        if (followLive && transcriptRef.current) {
          requestAnimationFrame(() => {
            if (transcriptRef.current) {
              transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
            }
          });
        }
      }

      if (message.type === 'participant.event') {
        const evt = message.data.event;
        setParticipantEvents(prev => [...prev, evt]);

        if (followLive && transcriptRef.current) {
          requestAnimationFrame(() => {
            if (transcriptRef.current) {
              transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
            }
          });
        }
      }

      if (message.type === 'meeting.status') {
        if (message.data.status === 'rtms_stopped') {
          setMeetingEnded(true);
        }
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, followLive]);

  // Scroll detection
  const handleScroll = useCallback(() => {
    if (!transcriptRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = transcriptRef.current;
    setFollowLive(scrollHeight - scrollTop - clientHeight < 100);
  }, []);

  const scrollToLive = () => {
    setFollowLive(true);
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  };

  // Merge segments and participant events into chronological timeline
  const timelineItems = useMemo(() => {
    const items = [];
    segments.forEach((seg, i) => {
      items.push({ type: 'transcript', ...seg, _ts: seg.tStartMs, _key: `seg-${i}` });
    });
    participantEvents
      .filter(evt => evt.eventType !== 'initial_roster')
      .forEach((evt, i) => {
        items.push({ type: 'participant-event', ...evt, _ts: evt.timestamp, _key: `evt-${i}` });
      });
    items.sort((a, b) => a._ts - b._ts);
    return items;
  }, [segments, participantEvents]);

  const dismissCta = () => {
    setCtaDismissed(true);
    sessionStorage.setItem('guest-cta-dismissed', 'true');
  };

  const handleInstall = () => {
    if (!isTestMode && zoomSdk?.promptAuthorize) {
      zoomSdk.promptAuthorize().catch(() => {});
    }
  };

  const isLive = !meetingEnded && (rtmsActive || meeting?.status === 'ongoing');
  const title = meetingContext?.meetingTopic || meeting?.title || 'Meeting';
  const summary = meeting?.summary;
  const ctaLabel = userContextStatus === 'unauthenticated' ? 'Sign in to Zoom' : 'Add Arlo';

  if (loading) {
    return (
      <div className="guest-in-meeting-loading">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="guest-in-meeting">
      {/* Compact header */}
      <div className="guest-compact-header">
        <div className="guest-header-brand">
          <OwlIcon size={20} />
          <span className="text-serif font-medium">Arlo</span>
        </div>
        <span className="guest-header-title text-serif text-sm">{title}</span>
        <div className="guest-header-badge">
          {isLive ? (
            <span className="guest-live-badge">
              <span className="guest-live-badge-dot" />
              Live
            </span>
          ) : (
            <span className="guest-ended-badge text-sans text-xs">Ended</span>
          )}
        </div>
      </div>

      <div className="guest-meeting-body">
        {/* Live transcript area */}
        <Card className="guest-transcript-live-card">
          <ScrollArea.Root className="guest-transcript-scroll-root">
            <ScrollArea.Viewport
              ref={transcriptRef}
              className="guest-transcript-viewport"
              onScroll={handleScroll}
            >
              {timelineItems.length === 0 && (
                <div className="guest-transcript-empty">
                  <LoadingSpinner size={24} />
                  <p className="text-serif text-sm text-muted">Waiting for transcript...</p>
                </div>
              )}
              {timelineItems.map((item) => {
                if (item.type === 'participant-event') {
                  return (
                    <div key={item._key} className="transcript-participant-event timeline-event-animate">
                      <InlineEventIcon eventType={item.eventType} />
                      <span className="transcript-event-text text-sans text-sm">
                        <InlineEventLabel eventType={item.eventType} name={item.participantName} />
                      </span>
                      <span className="transcript-event-time text-mono text-xs">
                        {formatTimestamp(item.timestamp)}
                      </span>
                    </div>
                  );
                }

                return (
                  <div key={item._key} className="transcript-entry">
                    <div className="transcript-entry-header">
                      <span className="transcript-timestamp text-mono text-xs text-muted">
                        {formatTimestamp(item.tStartMs)}
                      </span>
                      <span className="transcript-speaker text-sans text-sm font-medium">
                        {item.speakerLabel}
                      </span>
                    </div>
                    <p className="transcript-text text-serif text-sm">
                      {item.text}
                    </p>
                  </div>
                );
              })}
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical" className="scroll-area-scrollbar">
              <ScrollArea.Thumb className="scroll-area-scrollbar-thumb" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>

          {/* Scroll to live */}
          {!followLive && isLive && (
            <div className="scroll-to-live">
              <Button size="sm" onClick={scrollToLive}>
                <ArrowDown size={12} />
                Scroll to live
              </Button>
            </div>
          )}
        </Card>

        {/* Collapsible summary card */}
        <details className="guest-summary-details" open={meetingEnded}>
          <summary className="guest-summary-trigger">
            <Sparkles size={16} className="text-accent" />
            <span className="text-sans text-sm font-medium">Meeting Summary</span>
            <ChevronDown size={16} className="guest-summary-chevron" />
          </summary>
          <div className="guest-summary-content">
            {summary ? (
              <>
                {summary.overview && (
                  <p className="text-serif text-sm" style={{ lineHeight: 1.7 }}>
                    {summary.overview}
                  </p>
                )}
                {summary.keyDecisions?.length > 0 && (
                  <div className="guest-summary-section">
                    <h4 className="text-sans text-xs font-medium text-muted">Key Decisions</h4>
                    <ul className="guest-summary-list">
                      {summary.keyDecisions.map((d, i) => <li key={i} className="text-serif text-sm">{d}</li>)}
                    </ul>
                  </div>
                )}
                {summary.keyPoints?.length > 0 && (
                  <div className="guest-summary-section">
                    <h4 className="text-sans text-xs font-medium text-muted">Key Points</h4>
                    <ul className="guest-summary-list">
                      {summary.keyPoints.map((p, i) => <li key={i} className="text-serif text-sm">{p}</li>)}
                    </ul>
                  </div>
                )}
                {summary.actionItems?.length > 0 && (
                  <div className="guest-summary-section">
                    <h4 className="text-sans text-xs font-medium text-muted">Action Items</h4>
                    <ul className="guest-summary-list">
                      {summary.actionItems.map((a, i) => <li key={i} className="text-serif text-sm">{a}</li>)}
                    </ul>
                  </div>
                )}
              </>
            ) : isLive ? (
              <div className="guest-summary-skeleton">
                <div className="guest-skeleton-line" />
                <div className="guest-skeleton-line" />
                <div className="guest-skeleton-line" />
                <p className="text-sans text-xs text-muted" style={{ paddingTop: 4 }}>
                  Summary will be generated as the meeting progresses...
                </p>
              </div>
            ) : (
              <p className="text-serif text-sm text-muted">No summary available yet.</p>
            )}
          </div>
        </details>

        {/* Viewer count — show when others are viewing (subtract self) */}
        {viewers && viewers.viewerCount > 2 && (
          <div className="guest-viewer-bar text-sans text-xs text-muted">
            <Eye size={12} />
            <span>{viewers.viewerCount - 1} others viewing</span>
          </div>
        )}

        {/* Disabled AI chat teaser */}
        <div className="guest-chat-teaser">
          <Lock size={14} className="text-muted" />
          <span className="text-sans text-sm text-muted">Ask a follow-up question...</span>
          <button className="guest-chat-signin-link text-sans text-sm" onClick={handleInstall}>
            {ctaLabel} to chat
          </button>
        </div>

        {/* Post-meeting transition CTA */}
        {meetingEnded && (
          <Card className="guest-ended-cta-card">
            <div className="guest-ended-cta-inner">
              <OwlIcon size={32} />
              <h3 className="text-serif font-medium">Install Arlo to access this anytime</h3>
              <p className="text-sans text-sm text-muted">
                Save transcripts, get AI summaries, and search across all your meetings.
              </p>
              <Button size="lg" className="guest-install-btn" onClick={handleInstall}>
                {ctaLabel}
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Sticky bottom CTA bar */}
      {!ctaDismissed && !meetingEnded && (
        <div className="guest-sticky-cta">
          <span className="text-sans text-sm">Want to capture your own meetings?</span>
          <div className="guest-sticky-cta-actions">
            <Button size="sm" onClick={handleInstall}>{ctaLabel}</Button>
            <button className="guest-sticky-cta-dismiss" onClick={dismissCta}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
