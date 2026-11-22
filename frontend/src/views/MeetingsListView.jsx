import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MeetingCard from '../components/MeetingCard';
import DeleteMeetingDialog from '../components/DeleteMeetingDialog';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import { useServerSettings } from '../contexts/ServerSettingsContext';
import './MeetingsListView.css';

export default function MeetingsListView() {
  const navigate = useNavigate();
  const { showMeetingHistory, demoMode } = useServerSettings();
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    // Skip fetching if persistence is disabled
    if (!showMeetingHistory) {
      setLoading(false);
      return;
    }

    async function fetchMeetings() {
      try {
        const res = await fetch('/api/meetings', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setMeetings(data.meetings || []);
        }
      } catch {
        // Failed to fetch
      } finally {
        setLoading(false);
      }
    }
    fetchMeetings();
  }, [showMeetingHistory]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/meetings/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setMeetings((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      }
    } catch {
      // Delete failed
    }
    setDeleteTarget(null);
  };

  if (loading) {
    return (
      <div className="meetings-loading">
        <LoadingSpinner />
      </div>
    );
  }

  // Show message when demo mode is enabled
  if (demoMode) {
    return (
      <div className="meetings-list-view">
        <div className="meetings-empty">
          <p className="text-serif text-muted">Demo Mode</p>
          <p className="text-muted text-sm">
            Meeting history is disabled in demo mode. Real-time transcription still works during active meetings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="meetings-list-view">
      {meetings.length === 0 ? (
        <div className="meetings-empty">
          <p className="text-serif text-muted">No meetings yet</p>
          <p className="text-muted text-sm">
            Start a Zoom meeting with Arlo to see your meeting history.
          </p>
        </div>
      ) : (
        <div className="meetings-list">
          {meetings.map((meeting) => (
            <MeetingCard
              key={meeting.id}
              meeting={meeting}
              onClick={() => {
                if (meeting.status === 'ongoing') {
                  navigate(`/meeting/${encodeURIComponent(meeting.zoomMeetingId)}`);
                } else {
                  navigate(`/meetings/${meeting.id}`);
                }
              }}
              onDelete={(m) => setDeleteTarget(m)}
            />
          ))}
        </div>
      )}
      <DeleteMeetingDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        meetingTitle={deleteTarget?.title}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
