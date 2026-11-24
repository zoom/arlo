import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMeeting } from '../contexts/MeetingContext';
import { useArlo } from '../contexts/ArloContext';
import { accessHidesScreen } from '../lib/meetingAccess';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import MeetingAccessNotice from '../components/MeetingAccessNotice';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import TranscriptTimeline, { buildTimeline } from '../components/meeting/TranscriptTimeline';
// The timeline's own styles (transcript lines and events) live with the classic view
import './InMeetingView.css';
import './ArloMeetingView.css';
import './MeetingRecordView.css';

// The name the server gives to what Arlo's own stream connection did
const ARLO = 'Arlo';
const NO_SEGMENTS = [];

/**
 * The meeting record: what was said and what happened since Arlo joined, in
 * time order. Open to everyone in the meeting: the owner, participants and
 * guests. One toggle narrows it to what Arlo itself did. What Arlo was asked
 * and did is in it by its time, with how it ended when it was not done; the
 * server gives everyone the public ones and an owner their own private ones.
 */
export default function MeetingRecordView({ isGuestMode = false }) {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const {
    ws, meetingId, meetingAccess, connectWebSocket, segments, participantEvents,
  } = useMeeting();
  const { meetingOver, afterNotesMeetingId, actions } = useArlo();
  // The owner's notes of a meeting that is over are still held, and its record with them
  const afterMeeting = afterNotesMeetingId !== null;
  const { isAuthenticated } = useAuth();
  const { isTestMode, runningContext } = useZoomSdk();
  const [onlyArlo, setOnlyArlo] = useState(false);

  const shownSegments = onlyArlo ? NO_SEGMENTS : segments;
  const shownEvents = useMemo(
    () => (onlyArlo ? participantEvents.filter((event) => event.participantName === ARLO) : participantEvents),
    [onlyArlo, participantEvents],
  );
  const hasAnything = useMemo(() => buildTimeline(segments, participantEvents, actions).length > 0, [segments, participantEvents, actions]);
  const hasShown = useMemo(() => buildTimeline(shownSegments, shownEvents, actions).length > 0, [shownSegments, shownEvents, actions]);

  // Out of a meeting there is no record to read, except the one kept with the owner's notes
  const outsideMeeting = !isTestMode && runningContext !== null && runningContext !== 'inMeeting';
  const nothingToShow = outsideMeeting && !hasAnything && !afterMeeting;
  // A guest goes to the guest screen for no meeting
  const leaveTo = isAuthenticated ? '/home' : '/guest';
  useEffect(() => {
    if (nothingToShow) navigate(leaveTo, { replace: true });
  }, [nothingToShow, leaveTo, navigate]);

  // The meeting socket, when the panel was opened (or reloaded) on this screen
  useEffect(() => {
    if (ws || !meetingId) return;
    if (isGuestMode || isAuthenticated) connectWebSocket(meetingId);
  }, [isGuestMode, isAuthenticated, ws, meetingId, connectWebSocket]);

  const backPath = `${isGuestMode ? '/guest-meeting' : '/meeting'}/${encodeURIComponent(meetingId || routeId || '')}`;

  if (nothingToShow) return null;

  let content;
  if (accessHidesScreen(meetingAccess) && !hasAnything && !afterMeeting) {
    content = meetingAccess.status === 'idle' ? (
      <div className="arlo-center"><LoadingSpinner size={24} /></div>
    ) : (
      <MeetingAccessNotice
        access={meetingAccess}
        isGuestMode={isGuestMode}
        onRetry={() => connectWebSocket(meetingId)}
      />
    );
  } else {
    let empty = 'Nothing has been said since Arlo joined.';
    if (onlyArlo) empty = 'Arlo has not done anything yet.';
    else if (meetingOver) empty = 'The meeting has ended. Its record is not stored.';
    content = (
      <>
        <label className="record-toggle">
          <input type="checkbox" checked={onlyArlo} onChange={(e) => setOnlyArlo(e.target.checked)} />
          <span>Only Arlo&apos;s actions</span>
        </label>
        {hasShown ? (
          <div className="record-list">
            <TranscriptTimeline segments={shownSegments} participantEvents={shownEvents} actions={actions} />
          </div>
        ) : (
          <p className="arlo-muted record-empty">{empty}</p>
        )}
      </>
    );
  }

  return (
    <div className="arlo-view record-view">
      <div className="arlo-screen">
        <Link className="record-back" to={backPath}>Back</Link>
        <h1 className="arlo-title">Meeting record</h1>
        {content}
      </div>
    </div>
  );
}
