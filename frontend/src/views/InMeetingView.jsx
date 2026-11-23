import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Tabs } from '@base-ui/react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { ArrowDown, X, Sparkles, Users, GripVertical, RotateCcw, Volume2 } from 'lucide-react';
import { useMeeting } from '../contexts/MeetingContext';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { useToast } from '../contexts/ToastContext';
import { useVertical } from '../contexts/VerticalContext';
import useZoomAuth from '../hooks/useZoomAuth';
import { useDemoData } from '../hooks/useDemoData';
import { useFeatureLayout } from '../hooks/useFeatureLayout';
import { useVoiceCommands } from '../hooks/useVoiceCommands';
import TransportBar from '../components/TransportBar';
import MeetingTitle from '../components/meeting/MeetingTitle';
import ShareMenu from '../components/meeting/ShareMenu';
import TranscriptTimeline from '../components/meeting/TranscriptTimeline';
import { getTransportView } from '../lib/transportView';
import useMeetingVoiceHandlers from '../hooks/useMeetingVoiceHandlers';
import { useComplianceSettings } from '../hooks/useComplianceSettings';
import ArloResponsePanel from '../components/ArloResponsePanel';
import ComplianceAdvisor from '../components/ComplianceAdvisor';
import MeetingAccessNotice from '../components/MeetingAccessNotice';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Textarea from '../components/ui/Textarea';
import Input from '../components/ui/Input';
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
  FillerWordAlert,
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

export default function InMeetingView({ isGuestMode = false }) {
  const { id: routeId } = useParams(); // Get meeting ID from route for guest mode
  const navigate = useNavigate();
  const { ws, segments, participantEvents, rtmsActive, rtmsPaused, rtmsPhase, meetingId, connectWebSocket, viewers, meetingAccess, setWs, reportVoiceState } = useMeeting();
  const { isAuthenticated } = useAuth();
  const { zoomSdk, meetingContext, isTestMode, runningContext } = useZoomSdk();
  const { authorize } = useZoomAuth();
  const { hasFeature, verticalId, getTerm } = useVertical();

  // In guest mode, use 'general' vertical to show all features
  const effectiveVerticalId = isGuestMode ? 'general' : verticalId;
  const { showDemoData } = useDemoData();
  const { complianceEnabled } = useComplianceSettings();
  const { getFeatureOrder, updateFeatureOrder, hasCustomOrder, resetFeatureOrder } = useFeatureLayout();

  // Vertical-specific features (use effectiveVerticalId for guests)
  const isHealthcare = effectiveVerticalId === 'healthcare';
  const isLegal = effectiveVerticalId === 'legal';
  const isSales = effectiveVerticalId === 'sales';
  const isSupport = effectiveVerticalId === 'support';
  // eslint-disable-next-line no-unused-vars
  const isGeneral = effectiveVerticalId === 'general' || isGuestMode;

  // Get current feature order for this vertical
  const featureOrder = getFeatureOrder(effectiveVerticalId);

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

    updateFeatureOrder(effectiveVerticalId, newOrder);
  }, [featureOrder, updateFeatureOrder, effectiveVerticalId]);

  // Context guard: redirect to home if not in a meeting (skip for guests)
  useEffect(() => {
    if (isGuestMode) return; // Guests stay in meeting view
    if (isTestMode) return;
    if (runningContext === null) return; // SDK still loading
    if (runningContext !== 'inMeeting') {
      navigate('/home', { replace: true });
    }
  }, [isGuestMode, isTestMode, runningContext, navigate]);

  const { addToast } = useToast();
  const [followLive, setFollowLive] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [notes, setNotes] = useState('');
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState('');
  // Default to transcript tab - the live transcript is the "wow moment"
  const [activeTab, setActiveTab] = useState('transcript');
  const [voiceCommandsEnabled, setVoiceCommandsEnabled] = useState(true);
  const [showResponsePanel, setShowResponsePanel] = useState(true);
  const [voiceResponsesEnabled, setVoiceResponsesEnabled] = useState(() => {
    try {
      const cached = localStorage.getItem('arlo-voice-responses');
      return cached !== null ? JSON.parse(cached) : true;
    } catch {
      return true;
    }
  });
  const transcriptRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const meetingSummaryRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const decisionsLogRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const openQuestionsRef = useRef(null);

  // Listen for voice responses preference changes (from Settings)
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'arlo-voice-responses') {
        try {
          setVoiceResponsesEnabled(JSON.parse(e.newValue));
        } catch {}
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Auto-authenticate when entering meeting without a session
  const authAttemptedRef = useRef(false);
  useEffect(() => {
    if (isGuestMode) return; // Guests don't auto-authenticate
    if (isTestMode || isAuthenticated || authAttemptedRef.current) return;
    if (runningContext !== 'inMeeting' || !meetingContext?.meetingUUID) return;

    authAttemptedRef.current = true;
    authorize().catch((err) => console.error('Auth error:', err));
  }, [isGuestMode, isTestMode, isAuthenticated, runningContext, meetingContext, authorize]);

  // Connect WebSocket when authenticated and meeting is available (or for guests)
  // For guests, get meetingId from route params
  const effectiveMeetingId = isGuestMode ? (routeId ? decodeURIComponent(routeId) : null) : meetingId;
  useEffect(() => {
    if (ws) return; // Already connected
    if (!effectiveMeetingId) return; // No meeting ID yet

    // Guests connect too: their access is the verified meeting, not a sign-in
    if (isGuestMode || isAuthenticated) {
      connectWebSocket(effectiveMeetingId);
    }
  }, [isGuestMode, isAuthenticated, ws, effectiveMeetingId, connectWebSocket]);

  // Keep the newest line in view while following live
  useEffect(() => {
    if (!followLive) return;
    requestAnimationFrame(() => {
      if (transcriptRef.current) {
        transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
      }
    });
  }, [segments.length, participantEvents.length, followLive]);

  // AI suggestions pushed by the server
  useEffect(() => {
    if (!ws) return undefined;
    const handleMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'ai.suggestion') {
        setSuggestions((prev) => [...prev, message.data.suggestion].slice(-3));
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

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

  // What each voice command does (see hooks/useMeetingVoiceHandlers.js)
  const voiceHandlers = useMeetingVoiceHandlers({
    segments, meetingId: effectiveMeetingId, zoomSdk, addToast, setActiveTab, transcriptRef,
  });

  // Initialize voice commands hook
  // eslint-disable-next-line no-unused-vars
  const { lastCommand, isProcessing: voiceProcessing, responses: voiceResponses, clearResponses } = useVoiceCommands({
    ws,
    ...voiceHandlers,
    enabled: voiceCommandsEnabled && rtmsActive,
  });

  // Determine transcript state (initial_roster events don't count as displayable content)
  const hasContent = segments.length > 0 || participantEvents.some(e => e.eventType !== 'initial_roster');
  // Voice commands only run while this screen is open: tell the meeting
  // context, which shows it in Zoom's Dynamic Indicator.
  useEffect(() => {
    reportVoiceState?.(voiceCommandsEnabled && rtmsActive, voiceProcessing);
    return () => reportVoiceState?.(false, false);
  }, [reportVoiceState, voiceCommandsEnabled, rtmsActive, voiceProcessing]);

  const transcriptState = getTransportView({
    phase: rtmsPhase, active: rtmsActive, paused: rtmsPaused, hasContent,
  }).state;
  const showTranscript = transcriptState === 'live' || transcriptState === 'paused';

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
    'filler-word-alert': () => <FillerWordAlert segments={segments} showDemoData={showDemoData} />,
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
        <Droppable droppableId={`features-${effectiveVerticalId}`}>
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
  }, [featureOrder, featureRenderers, handleDragEnd, effectiveVerticalId]);

  // Early return while redirecting (after all hooks)
  if (!isTestMode && runningContext !== null && runningContext !== 'inMeeting') {
    return null;
  }

  return (
    <div className="in-meeting-view">
      {/* Meeting header */}
      <div className="in-meeting-header">
        <div className="live-indicator-row">
          <MeetingTitle canEdit={isAuthenticated} />
        </div>
        {viewers && viewers.guestCount > 0 && (
          <span className="viewer-count text-sans text-xs text-muted">
            <Users size={12} />
            {viewers.guestCount} {viewers.guestCount === 1 ? 'guest' : 'guests'} viewing
          </span>
        )}
        {/* Voice commands indicator */}
        {rtmsActive && (
          <button
            className={`voice-commands-indicator ${voiceProcessing ? 'processing' : ''} ${voiceResponses.length > 0 ? 'has-responses' : ''} ${!voiceCommandsEnabled ? 'disabled' : ''}`}
            onClick={() => {
              if (voiceResponses.length > 0) {
                setShowResponsePanel(prev => !prev);
              } else {
                setVoiceCommandsEnabled(prev => !prev);
              }
            }}
            title={voiceCommandsEnabled ? 'Say "Hey Arlo" followed by a command. Click to toggle panel.' : 'Voice commands disabled. Click to enable.'}
          >
            <Volume2 size={14} />
            <span className="text-sans text-xs">{voiceCommandsEnabled ? 'Voice' : 'Voice Off'}</span>
            {voiceResponses.length > 0 && (
              <span className="voice-badge">{voiceResponses.length}</span>
            )}
          </button>
        )}
      </div>

      {/* Voice command response panel - inline above tabs */}
      {voiceResponsesEnabled && showResponsePanel && (voiceResponses.length > 0 || voiceProcessing) && (
        <ArloResponsePanel
          responses={voiceResponses}
          isProcessing={voiceProcessing}
          onClear={clearResponses}
          onClose={() => setShowResponsePanel(false)}
          inline
        />
      )}

      {/* Transcription status and controls: one bar for both tabs */}
      <TransportBar
        guest={isGuestMode}
        hasContent={hasContent}
        extra={rtmsActive && <ShareMenu canCollaborate={!isTestMode && !isGuestMode} />}
      />

      {/* Tabs: Transcript (default) | Arlo Assist */}
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => setActiveTab(value)}
        className="in-meeting-tabs"
      >
        <Tabs.List className="tabs-list" data-cols="2">
          <Tabs.Tab value="transcript" className="tab-trigger">Transcript</Tabs.Tab>
          <Tabs.Tab value="assist" className="tab-trigger">Arlo Assist</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="transcript" className="in-meeting-tab-panel">
          <MeetingAccessNotice
            access={meetingAccess}
            isGuestMode={isGuestMode}
            onRetry={() => {
              setWs(null);
              connectWebSocket(effectiveMeetingId);
            }}
          />
          {!showTranscript && (
            <Card className="transcript-state-card">
              <div className="transcript-state-inner">
                <p className="text-serif text-muted">
                  {transcriptState === 'waiting'
                    ? 'Listening. The transcript appears here when someone speaks.'
                    : 'The transcript appears here once transcription starts.'}
                </p>
              </div>
            </Card>
          )}

          {showTranscript && (
            <div className="transcript-active-container">
              {/* Transcript card */}
              <Card className="transcript-live-card">
                {/* Healthcare: Show detected symptoms/medications */}
                {isHealthcare && hasFeature('symptoms') && (
                  <HealthcareTagsSummary
                    segments={segments}
                    demoMode={showDemoData}
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

                <TranscriptTimeline
                  segments={segments}
                  participantEvents={participantEvents}
                  viewportRef={transcriptRef}
                  onScroll={handleScroll}
                  renderText={isHealthcare ? highlightMedicalTerms : undefined}
                />

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
          {/* Feature reorder toolbar */}
          {hasCustomOrder(effectiveVerticalId) && (
            <div className="feature-reorder-toolbar">
              <span className="text-xs text-muted">Custom order active</span>
              <button
                className="reset-order-btn"
                onClick={() => resetFeatureOrder(effectiveVerticalId)}
                title="Reset to default order"
              >
                <RotateCcw size={14} />
                <span className="text-xs">Reset Order</span>
              </button>
            </div>
          )}

          {/* Compliance Advisor - Cross-vertical compliance monitoring */}
          {complianceEnabled && (
            <ComplianceAdvisor
              segments={segments}
              vertical={effectiveVerticalId === 'general' ? 'notes' : effectiveVerticalId}
              enabled={complianceEnabled && rtmsActive}
            />
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
