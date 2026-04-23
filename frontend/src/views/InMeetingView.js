import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Tabs, ScrollArea } from '@base-ui/react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { ArrowDown, X, Sparkles, Pause, Play, Square, LogIn, LogOut, Mic, MicOff, Share2, Check, Users, Pencil, Loader2, GripVertical, RotateCcw, MonitorPlay } from 'lucide-react';
import { useMeeting } from '../contexts/MeetingContext';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { useToast } from '../contexts/ToastContext';
import { useVertical } from '../contexts/VerticalContext';
import useZoomAuth from '../hooks/useZoomAuth';
import { useDemoData } from '../hooks/useDemoData';
import { useFeatureLayout } from '../hooks/useFeatureLayout';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Textarea from '../components/ui/Textarea';
import Input from '../components/ui/Input';
import LoadingSpinner from '../components/ui/LoadingSpinner';
// Healthcare vertical features
import {
  SOAPNotesPanel,
  PatientContextCard,
  PreviousSessionsCard,
  ClinicalAlerts,
  QuickActions,
  HealthcareTagsSummary,
  highlightMedicalTerms,
} from '../features/healthcare';
// Legal vertical features
import {
  ContradictionDetector,
  BillableTimeTracker,
  LegalTermsPanel,
  ExhibitTracker,
  PrivilegeMarkers,
} from '../features/legal';
// Sales vertical features
import {
  DealTracker,
  CompetitorMentions,
  CommitmentsPanel,
  QualificationSignals,
} from '../features/sales';
// Customer Support vertical features
import {
  SentimentMeter,
  EscalationAlerts,
  ResolutionTracker,
  AgentAssist,
} from '../features/support';
// General meeting features (default note-taker)
import {
  MeetingSummary,
  KeyMoments,
  DecisionsLog,
  OpenQuestions,
  ParticipantStats,
  SmartBookmarks,
} from '../features/general';
import './InMeetingView.css';

function formatTimestamp(ms) {
  const date = new Date(ms);
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

export default function InMeetingView() {
  useParams(); // id available from route but meetingId comes from context
  const navigate = useNavigate();
  const { ws, rtmsActive, rtmsPaused, rtmsLoading, startRTMS, stopRTMS, pauseRTMS, resumeRTMS, meetingId, connectWebSocket, viewers, setTitleUserRenamed } = useMeeting();
  const { isAuthenticated, wsToken } = useAuth();
  const { zoomSdk, meetingContext, isTestMode, runningContext } = useZoomSdk();
  const { authorize } = useZoomAuth();
  const { hasFeature, verticalId, getTerm } = useVertical();
  const { showDemoData } = useDemoData();
  const { getFeatureOrder, updateFeatureOrder, hasCustomOrder, resetFeatureOrder } = useFeatureLayout();

  // Vertical-specific features
  const isHealthcare = verticalId === 'healthcare';
  const isLegal = verticalId === 'legal';
  const isSales = verticalId === 'sales';
  const isSupport = verticalId === 'support';

  // Get current feature order for this vertical
  const featureOrder = getFeatureOrder(verticalId);

  // Shared jump-to-segment handler
  const handleJumpToSegment = useCallback((seqNo) => {
    if (transcriptRef.current) {
      const element = transcriptRef.current.querySelector(`[data-seq="${seqNo}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('highlight-flash');
        setTimeout(() => element.classList.remove('highlight-flash'), 2000);
      }
    }
  }, []);

  // Handle drag end for feature reordering
  const handleDragEnd = useCallback((result) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;

    const newOrder = Array.from(featureOrder);
    const [removed] = newOrder.splice(result.source.index, 1);
    newOrder.splice(result.destination.index, 0, removed);

    updateFeatureOrder(verticalId, newOrder);
  }, [featureOrder, updateFeatureOrder, verticalId]);

  // Context guard: redirect to home if not in a meeting
  useEffect(() => {
    if (isTestMode) return;
    if (runningContext === null) return; // SDK still loading
    if (runningContext !== 'inMeeting') {
      navigate('/home', { replace: true });
    }
  }, [isTestMode, runningContext, navigate]);

  const { addToast } = useToast();
  const [segments, setSegments] = useState([]);
  const [participantEvents, setParticipantEvents] = useState([]);
  const [followLive, setFollowLive] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [notes, setNotes] = useState('');
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState('');
  const [inviteMenuOpen, setInviteMenuOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [isCollaborating, setIsCollaborating] = useState(false);
  const [collaborateLoading, setCollaborateLoading] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(null);
  // Always default to "assist" tab (features page) when entering a meeting
  const [activeTab, setActiveTab] = useState('assist');
  const transcriptRef = useRef(null);
  const inviteDropdownRef = useRef(null);

  // Auto-authenticate when entering meeting without a session
  const authAttemptedRef = useRef(false);
  useEffect(() => {
    if (isTestMode || isAuthenticated || authAttemptedRef.current) return;
    if (runningContext !== 'inMeeting' || !meetingContext?.meetingUUID) return;

    authAttemptedRef.current = true;
    authorize().catch((err) => console.error('Auth error:', err));
  }, [isTestMode, isAuthenticated, runningContext, meetingContext, authorize]);

  // Connect WebSocket when authenticated and meeting is available
  useEffect(() => {
    if (!isAuthenticated || ws || !meetingId) return;
    connectWebSocket(wsToken, meetingId);
  }, [isAuthenticated, ws, meetingId, wsToken, connectWebSocket]);

  // Load existing transcript segments from DB (for auto-started RTMS sessions)
  const historicalLoadedRef = useRef(false);
  useEffect(() => {
    if (!rtmsActive || !meetingId || historicalLoadedRef.current) return;
    historicalLoadedRef.current = true;

    fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/transcript`, {
      credentials: 'include',
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.segments?.length > 0) {
          setSegments(prev => {
            // Merge: DB segments first, then any WS segments not already present
            const dbSeqs = new Set(data.segments.map(s => s.seqNo));
            const newFromWs = prev.filter(s => !dbSeqs.has(String(s.seqNo)));
            return [...data.segments, ...newFromWs];
          });
          console.log(`Loaded ${data.segments.length} historical segments from DB`);
        }
      })
      .catch(() => {});
  }, [rtmsActive, meetingId]);

  // Load existing participant events from DB (for mid-meeting app opens)
  const historicalEventsLoadedRef = useRef(false);
  useEffect(() => {
    if (!rtmsActive || !meetingId || historicalEventsLoadedRef.current) return;
    historicalEventsLoadedRef.current = true;

    fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/participant-events`, {
      credentials: 'include',
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.events?.length > 0) {
          setParticipantEvents(prev => {
            // Merge: DB events first, then any WS events not already present
            const dbIds = new Set(data.events.map(e => e.id));
            const newFromWs = prev.filter(e => !dbIds.has(e.id));
            return [...data.events, ...newFromWs];
          });
          console.log(`Loaded ${data.events.length} historical participant events from DB`);
        }
      })
      .catch(() => {});
  }, [rtmsActive, meetingId]);

  // Listen for transcript segments
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'transcript.segment') {
        const { segment } = message.data;
        setSegments((prev) => {
          if (prev.some(s => s.seqNo === segment.seqNo)) return prev;
          return [...prev, segment];
        });

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
        setParticipantEvents((prev) => [...prev, evt]);

        if (followLive && transcriptRef.current) {
          requestAnimationFrame(() => {
            if (transcriptRef.current) {
              transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
            }
          });
        }
      }

      if (message.type === 'ai.suggestion') {
        setSuggestions((prev) => [...prev, message.data.suggestion].slice(-3));
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

  const dismissSuggestion = (index) => {
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  };

  const addTask = () => {
    if (!newTask.trim()) return;
    setTasks([...tasks, { id: Date.now().toString(), task: newTask, owner: 'Unassigned' }]);
    setNewTask('');
  };

  // Invite handlers
  const handleInviteAll = useCallback(async () => {
    if (!zoomSdk?.sendAppInvitationToAllParticipants) return;
    try {
      await zoomSdk.sendAppInvitationToAllParticipants();
      setInviteSent(true);
      setInviteMenuOpen(false);
      addToast('Invitation sent to all participants', 'success');
      setTimeout(() => setInviteSent(false), 3000);
    } catch (err) {
      console.error('sendAppInvitationToAllParticipants failed:', err);
      addToast('Failed to send invitation', 'error');
    }
  }, [zoomSdk, addToast]);

  const handleInviteChoose = useCallback(() => {
    if (!zoomSdk?.showAppInvitationDialog) return;
    zoomSdk.showAppInvitationDialog().catch((err) => {
      console.error('showAppInvitationDialog failed:', err);
    });
    setInviteMenuOpen(false);
  }, [zoomSdk]);

  // Collaborate mode handler
  const handleCollaborate = useCallback(async () => {
    if (!zoomSdk) return;
    setCollaborateLoading(true);
    try {
      if (isCollaborating) {
        // End collaborate mode
        await zoomSdk.endCollaborate();
        setIsCollaborating(false);
        addToast('Collaborate mode ended', 'info');
      } else {
        // Start collaborate mode
        await zoomSdk.startCollaborate({
          shareScreen: false, // Don't share screen, just open app for all
        });
        setIsCollaborating(true);
        addToast('Collaborate mode started - all participants can now see Arlo', 'success');
      }
    } catch (err) {
      console.error('Collaborate mode error:', err);
      // Try alternative method if startCollaborate doesn't exist
      if (err.message?.includes('not a function') || err.message?.includes('undefined')) {
        try {
          await zoomSdk.runRenderingContext({
            view: 'immersive',
          });
          setIsCollaborating(true);
          addToast('Collaborate mode started', 'success');
        } catch (fallbackErr) {
          console.error('Fallback collaborate error:', fallbackErr);
          addToast('Collaborate mode not available: ' + (fallbackErr.message || 'Unknown error'), 'error');
        }
      } else {
        addToast('Failed to toggle collaborate mode: ' + (err.message || 'Unknown error'), 'error');
      }
    } finally {
      setCollaborateLoading(false);
    }
  }, [zoomSdk, isCollaborating, addToast]);

  // Close invite dropdown on click outside
  useEffect(() => {
    if (!inviteMenuOpen) return;
    const handleClickOutside = (e) => {
      if (inviteDropdownRef.current && !inviteDropdownRef.current.contains(e.target)) {
        setInviteMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [inviteMenuOpen]);

  // Register onSendAppInvitation listener for confirmation
  useEffect(() => {
    if (!zoomSdk?.onSendAppInvitation) return;
    const handler = () => {
      setInviteSent(true);
      setTimeout(() => setInviteSent(false), 3000);
    };
    zoomSdk.onSendAppInvitation(handler);
  }, [zoomSdk]);

  const handlePause = () => {
    pauseRTMS();
  };

  const handleResume = () => {
    resumeRTMS();
  };

  const handleStop = () => {
    stopRTMS();
  };

  // Determine transcript state (initial_roster events don't count as displayable content)
  const hasContent = segments.length > 0 || participantEvents.some(e => e.eventType !== 'initial_roster');
  const transcriptState = rtmsPaused
    ? 'paused'
    : rtmsActive && hasContent
      ? 'live'
      : rtmsActive
        ? 'waiting'
        : 'not-started';

  // Merge transcript segments and participant events into a chronological timeline
  // Filter out initial_roster events — they're not real joins, just the SDK reporting existing participants
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

  // Feature renderers for each vertical - maps feature ID to render function
  const featureRenderers = useMemo(() => ({
    // Healthcare features
    'clinical-alerts': () => <ClinicalAlerts segments={segments} showDemoData={showDemoData} />,
    'patient-context': () => hasFeature('patientContext') ? <PatientContextCard segments={segments} meetingId={meetingId} showDemoData={showDemoData} /> : null,
    'previous-sessions': () => <PreviousSessionsCard patientId={meetingId} showDemoData={showDemoData} />,
    'soap-notes': () => hasFeature('soapNotes') ? <SOAPNotesPanel segments={segments} meetingId={meetingId} isLive={rtmsActive && !rtmsPaused} showDemoData={showDemoData} /> : null,
    'quick-actions': () => <QuickActions soapData={{ subjective: '', objective: '', assessment: '', plan: '' }} onAction={(action, option) => console.log('Quick action:', action, option)} showDemoData={showDemoData} />,

    // Legal features
    'contradiction-detector': () => <ContradictionDetector segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'legal-terms': () => <LegalTermsPanel segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'billable-time': () => <BillableTimeTracker meetingId={meetingId} meetingStartTime={segments[0]?.timestamp} showDemoData={showDemoData} />,
    'exhibit-tracker': () => <ExhibitTracker segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'privilege-markers': () => <PrivilegeMarkers segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,

    // Sales features
    'qualification-signals': () => <QualificationSignals segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'competitor-mentions': () => <CompetitorMentions segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'commitments': () => <CommitmentsPanel segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'deal-tracker': () => <DealTracker segments={segments} meetingId={meetingId} showDemoData={showDemoData} />,

    // Support features
    'sentiment-meter': () => <SentimentMeter segments={segments} showDemoData={showDemoData} />,
    'escalation-alerts': () => <EscalationAlerts segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'resolution-tracker': () => <ResolutionTracker segments={segments} showDemoData={showDemoData} />,
    'agent-assist': () => <AgentAssist segments={segments} showDemoData={showDemoData} />,

    // General features
    'meeting-summary': () => <MeetingSummary segments={segments} meetingId={meetingId} showDemoData={showDemoData} />,
    'key-moments': () => <KeyMoments segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'decisions-log': () => <DecisionsLog segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'open-questions': () => <OpenQuestions segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'smart-bookmarks': () => <SmartBookmarks segments={segments} showDemoData={showDemoData} onJumpToSegment={handleJumpToSegment} />,
    'participant-stats': () => <ParticipantStats segments={segments} showDemoData={showDemoData} />,
  }), [segments, meetingId, showDemoData, rtmsActive, rtmsPaused, hasFeature, handleJumpToSegment]);

  // Render draggable features for current vertical
  const renderDraggableFeatures = useCallback(() => {
    return (
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId={`features-${verticalId}`}>
          {(provided, snapshot) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={`draggable-features ${snapshot.isDraggingOver ? 'drag-over' : ''}`}
            >
              {featureOrder.map((featureId, index) => {
                const renderer = featureRenderers[featureId];
                if (!renderer) return null;
                const content = renderer();
                if (!content) return null;

                return (
                  <Draggable key={featureId} draggableId={featureId} index={index}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        className={`draggable-feature ${snapshot.isDragging ? 'is-dragging' : ''}`}
                      >
                        <div
                          {...provided.dragHandleProps}
                          className="drag-handle"
                          title="Drag to reorder"
                        >
                          <GripVertical size={16} />
                        </div>
                        {content}
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    );
  }, [featureOrder, featureRenderers, handleDragEnd, verticalId]);

  // Early return while redirecting (after all hooks)
  if (!isTestMode && runningContext !== null && runningContext !== 'inMeeting') {
    return null;
  }

  // Title editing handlers
  const handleEditTitle = () => {
    setIsEditingTitle(true);
    setEditedTitle(displayTitle || meetingContext?.meetingTopic || 'Live Meeting');
  };

  const handleSaveTitle = async () => {
    if (!editedTitle.trim() || editedTitle === (displayTitle || meetingContext?.meetingTopic || 'Live Meeting')) {
      setIsEditingTitle(false);
      return;
    }
    setIsSavingTitle(true);
    try {
      const res = await fetch(`/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/topic`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: editedTitle, force: true }),
      });
      if (res.ok) {
        setDisplayTitle(editedTitle);
        setTitleUserRenamed();
        addToast('Meeting renamed', 'success');
      } else {
        addToast('Failed to rename meeting', 'error');
      }
    } catch {
      addToast('Failed to rename meeting', 'error');
    } finally {
      setIsSavingTitle(false);
      setIsEditingTitle(false);
    }
  };

  const handleCancelEditTitle = () => {
    setIsEditingTitle(false);
  };

  const handleGenerateTitle = async (e) => {
    e.stopPropagation();
    setIsGeneratingTitle(true);
    try {
      const res = await fetch('/api/ai/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId }),
      });
      if (res.ok) {
        const data = await res.json();
        setEditedTitle(data.title);
        setIsEditingTitle(true);
      } else {
        addToast('Failed to generate title', 'error');
      }
    } catch {
      addToast('Failed to generate title', 'error');
    } finally {
      setIsGeneratingTitle(false);
    }
  };

  // Get meeting title (user rename > Zoom topic > fallback)
  const title = displayTitle || meetingContext?.meetingTopic || 'Live Meeting';
  const participants = []; // TODO: from Zoom SDK getMeetingParticipants

  return (
    <div className="in-meeting-view">
      {/* Meeting header */}
      <div className="in-meeting-header">
        <div className="live-indicator-row">
          <div className="live-dot-container">
            <div className="live-dot" />
            <div className="live-dot-ping" />
          </div>
          {isAuthenticated && isEditingTitle ? (
            <div className="title-edit-row">
              <input
                type="text"
                className="input title-edit-input text-serif text-2xl"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTitle();
                  if (e.key === 'Escape') handleCancelEditTitle();
                }}
                autoFocus
                onFocus={(e) => e.target.select()}
              />
              <Button variant="ghost" size="icon" onClick={handleSaveTitle} disabled={isSavingTitle}>
                {isSavingTitle ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              </Button>
              <Button variant="ghost" size="icon" onClick={handleCancelEditTitle} disabled={isSavingTitle}>
                <X size={16} />
              </Button>
            </div>
          ) : isAuthenticated ? (
            <div className="title-display" onClick={handleEditTitle}>
              <h1 className="text-serif text-2xl">{title}</h1>
              <Pencil size={16} className="title-action text-muted" />
              <button
                className="title-action-btn"
                onClick={handleGenerateTitle}
                disabled={isGeneratingTitle}
                title="Generate title with AI"
              >
                {isGeneratingTitle
                  ? <Loader2 size={16} className="spin text-muted" />
                  : <Sparkles size={16} className="title-action text-muted" />
                }
              </button>
            </div>
          ) : (
            <h1 className="text-serif text-2xl">{title}</h1>
          )}
        </div>
        {participants.length > 0 && (
          <p className="text-sans text-sm text-muted">{participants.join(', ')}</p>
        )}
        {viewers && viewers.guestCount > 0 && (
          <span className="viewer-count text-sans text-xs text-muted">
            <Users size={12} />
            {viewers.guestCount} {viewers.guestCount === 1 ? 'guest' : 'guests'} viewing
          </span>
        )}
      </div>

      {/* Tabs: Arlo Assist (default) | Transcript */}
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => setActiveTab(value)}
        className="in-meeting-tabs"
      >
        <Tabs.List className="tabs-list" data-cols="2">
          <Tabs.Tab value="assist" className="tab-trigger">Arlo Assist</Tabs.Tab>
          <Tabs.Tab value="transcript" className="tab-trigger">Transcript</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="transcript" className="in-meeting-tab-panel">
          {transcriptState === 'not-started' && (
            <Card className="transcript-state-card">
              <div className="transcript-state-inner">
                <p className="text-serif text-muted">Transcription not started</p>
                <Button onClick={() => startRTMS(false)} disabled={rtmsLoading}>
                  {rtmsLoading ? 'Starting...' : 'Start Transcription'}
                </Button>
              </div>
            </Card>
          )}

          {transcriptState === 'waiting' && (
            <Card className="transcript-state-card">
              <div className="transcript-state-inner">
                <LoadingSpinner size={32} />
                <p className="text-serif text-muted">Waiting for transcript...</p>
              </div>
            </Card>
          )}

          {(transcriptState === 'live' || transcriptState === 'paused') && (
            <div className="transcript-active-container">
              {/* Transcription controls bar */}
              <Card className="transcript-controls-card">
                <div className="transcript-controls">
                  <div className="transcript-status">
                    {transcriptState === 'live' ? (
                      <>
                        <div className="live-dot-container">
                          <div className="recording-dot" />
                          <div className="recording-dot-ping" />
                        </div>
                        <span className="text-sans text-sm text-muted">Transcribing</span>
                      </>
                    ) : (
                      <span className="paused-badge text-sans">Paused</span>
                    )}
                  </div>
                  <div className="transcript-controls-buttons">
                    {transcriptState === 'live' ? (
                      <>
                        <Button variant="outline" size="sm" onClick={handlePause} disabled={rtmsLoading}>
                          <Pause size={12} />
                          Pause
                        </Button>
                        <Button variant="outline" size="sm" className="btn-destructive-outline" onClick={handleStop} disabled={rtmsLoading}>
                          <Square size={12} />
                          Stop
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" onClick={handleResume} disabled={rtmsLoading}>
                          <Play size={12} />
                          Resume
                        </Button>
                        <Button variant="outline" size="sm" className="btn-destructive-outline" onClick={handleStop} disabled={rtmsLoading}>
                          <Square size={12} />
                          Stop
                        </Button>
                      </>
                    )}
                    {/* Collaborate mode */}
                    {!isTestMode && (
                      <Button
                        variant={isCollaborating ? 'primary' : 'outline'}
                        size="sm"
                        onClick={handleCollaborate}
                        disabled={collaborateLoading}
                        title={isCollaborating ? 'End collaborate mode' : 'Start collaborate mode - share Arlo with all participants'}
                      >
                        {collaborateLoading ? <Loader2 size={12} className="animate-spin" /> : <MonitorPlay size={12} />}
                        {isCollaborating ? 'End Collab' : 'Collaborate'}
                      </Button>
                    )}
                    {/* Invite participants */}
                    {(
                    <div className="invite-dropdown-container" ref={inviteDropdownRef}>
                      <Button
                        variant="outline"
                        size="sm"
                        className={inviteSent ? 'invite-sent' : ''}
                        onClick={() => setInviteMenuOpen(prev => !prev)}
                      >
                        {inviteSent ? <Check size={12} /> : <Share2 size={12} />}
                        {inviteSent ? 'Sent' : 'Invite'}
                      </Button>
                      {inviteMenuOpen && (
                        <div className="invite-dropdown">
                          <button className="invite-dropdown-item" onClick={handleInviteAll}>
                            <Users size={14} />
                            Invite all participants
                          </button>
                          <button className="invite-dropdown-item" onClick={handleInviteChoose}>
                            <Share2 size={14} />
                            Choose participants...
                          </button>
                        </div>
                      )}
                    </div>
                    )}
                  </div>
                </div>
              </Card>

              {/* Transcript card */}
              <Card className="transcript-live-card">
                {transcriptState === 'paused' && (
                  <div className="transcript-paused-pill">
                    <span className="text-sans text-xs text-muted">Transcript paused</span>
                  </div>
                )}

                {/* Healthcare: Show detected symptoms/medications */}
                {isHealthcare && hasFeature('symptoms') && (
                  <HealthcareTagsSummary
                    segments={segments}
                    onTagClick={(occurrence) => {
                      // Scroll to the relevant segment
                      if (transcriptRef.current) {
                        const element = transcriptRef.current.querySelector(`[data-seq="${occurrence.segmentSeqNo}"]`);
                        if (element) {
                          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          element.classList.add('highlight-flash');
                          setTimeout(() => element.classList.remove('highlight-flash'), 2000);
                        }
                      }
                    }}
                  />
                )}

                <ScrollArea.Root className="transcript-scroll-root">
                  <ScrollArea.Viewport
                    ref={transcriptRef}
                    className="transcript-viewport"
                    onScroll={handleScroll}
                  >
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
                        <div key={item._key} className="transcript-entry" data-seq={item.seqNo}>
                          <div className="transcript-entry-header">
                            <span className="transcript-timestamp text-mono text-xs text-muted">
                              {formatTimestamp(item.tStartMs)}
                            </span>
                            <span className="transcript-speaker text-sans text-sm font-medium">
                              {item.speakerLabel}
                            </span>
                          </div>
                          <p className="transcript-text text-serif text-sm">
                            {isHealthcare ? highlightMedicalTerms(item.text) : item.text}
                          </p>
                        </div>
                      );
                    })}
                  </ScrollArea.Viewport>
                  <ScrollArea.Scrollbar orientation="vertical" className="scroll-area-scrollbar">
                    <ScrollArea.Thumb className="scroll-area-scrollbar-thumb" />
                  </ScrollArea.Scrollbar>
                </ScrollArea.Root>

                {/* Suggestion bubbles */}
                {suggestions.length > 0 && (
                  <div className="suggestion-bubbles">
                    {suggestions.map((s, i) => (
                      <Card key={i} className="suggestion-bubble">
                        <div className="suggestion-inner">
                          <Sparkles size={14} className="text-accent" />
                          <span className="text-sans text-sm">{s.text}</span>
                          <button className="suggestion-dismiss" onClick={() => dismissSuggestion(i)}>
                            <X size={14} />
                          </button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Scroll to live */}
                {!followLive && transcriptState === 'live' && (
                  <div className="scroll-to-live">
                    <Button size="sm" onClick={scrollToLive}>
                      <ArrowDown size={12} />
                      Scroll to live
                    </Button>
                  </div>
                )}
              </Card>
            </div>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="assist" className="in-meeting-tab-panel">
          {/* Compact transcription status bar on Arlo Assist tab */}
          <Card className="assist-transcript-status">
            <div className="assist-transcript-status-inner">
              {transcriptState === 'not-started' ? (
                <>
                  <span className="text-sans text-sm text-muted">Transcription not started</span>
                  <Button size="sm" onClick={() => startRTMS(false)} disabled={rtmsLoading}>
                    <Mic size={14} />
                    {rtmsLoading ? 'Starting...' : 'Start'}
                  </Button>
                </>
              ) : transcriptState === 'waiting' ? (
                <>
                  <div className="assist-status-live">
                    <LoadingSpinner size={14} />
                    <span className="text-sans text-sm text-muted">Waiting for transcript...</span>
                  </div>
                </>
              ) : transcriptState === 'paused' ? (
                <>
                  <span className="paused-badge-sm text-sans text-sm">Paused</span>
                  <div className="assist-transcript-controls">
                    <Button size="sm" onClick={handleResume} disabled={rtmsLoading}>
                      <Play size={14} />
                      Resume
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setActiveTab('transcript')}>
                      View Transcript
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="assist-status-live">
                    <div className="live-dot-container small">
                      <div className="recording-dot" />
                      <div className="recording-dot-ping" />
                    </div>
                    <span className="text-sans text-sm text-muted">Transcribing</span>
                    <span className="text-sans text-xs text-muted">({segments.length} segments)</span>
                  </div>
                  <div className="assist-transcript-controls">
                    <Button variant="outline" size="sm" onClick={handlePause} disabled={rtmsLoading}>
                      <Pause size={14} />
                      Pause
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setActiveTab('transcript')}>
                      View Transcript
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* Feature reorder toolbar */}
          {hasCustomOrder(verticalId) && (
            <div className="feature-reorder-toolbar">
              <span className="text-xs text-muted">Custom order active</span>
              <button
                className="reset-order-btn"
                onClick={() => resetFeatureOrder(verticalId)}
                title="Reset to default order"
              >
                <RotateCcw size={14} />
                <span className="text-xs">Reset Order</span>
              </button>
            </div>
          )}

          {/* Draggable feature cards */}
          {renderDraggableFeatures()}

          {/* Notes section (outside drag area) */}
          <Card className="assist-card">
            <div className="assist-card-inner">
              <h3 className="text-serif font-medium">
                {isLegal ? 'Deposition Notes' : isSales ? 'Call Notes' : isSupport ? 'Case Notes' : 'Notes'}
              </h3>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={
                  isLegal ? 'Attorney notes, follow-up questions, impeachment points...' :
                  isSales ? 'Key takeaways, objections to address, follow-up items...' :
                  isSupport ? 'Issue summary, troubleshooting steps, resolution notes...' :
                  'Meeting notes...'
                }
                className="assist-notes"
              />
            </div>
          </Card>

          {/* Action Items (General vertical only) */}
          {!isHealthcare && !isLegal && !isSales && !isSupport && (
            <Card className="assist-card">
              <div className="assist-card-inner">
                <h3 className="text-serif font-medium">{getTerm('actionItem')}s</h3>

                <div className="action-items-list">
                  {tasks.map((task) => (
                    <div key={task.id} className="action-item">
                      <p className="text-serif text-sm">{task.task}</p>
                      <p className="text-sans text-xs text-muted">Owner: {task.owner}</p>
                    </div>
                  ))}
                </div>

                <div className="add-action-row">
                  <Input
                    placeholder={`Add ${getTerm('actionItem').toLowerCase()}...`}
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addTask()}
                  />
                  <Button size="sm" onClick={addTask}>Add</Button>
                </div>
              </div>
            </Card>
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
