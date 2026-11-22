import React, { useState } from 'react';
import { Check, X, Pencil, Sparkles, Loader2 } from 'lucide-react';
import { useMeeting } from '../../contexts/MeetingContext';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import { getPreferredAiModel } from '../../utils/aiModel';
import { transcriptToText } from '../../lib/transcript';
import Button from '../ui/Button';

const FALLBACK_TITLE = 'Live Meeting';

/**
 * The meeting title: the Zoom topic, or the user's own name for the meeting.
 * Signed-in users can rename it or ask the AI to suggest a title from the
 * live transcript. Guests see it read-only.
 */
export default function MeetingTitle({ canEdit = false }) {
  const { meetingId, segments, setTitleUserRenamed } = useMeeting();
  const { meetingContext } = useZoomSdk();
  const { addToast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(null);

  // user rename > Zoom topic > fallback
  const title = displayTitle || meetingContext?.meetingTopic || FALLBACK_TITLE;

  const startEditing = () => {
    setIsEditing(true);
    setEditedTitle(title);
  };

  const save = async () => {
    if (!editedTitle.trim() || editedTitle === title) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
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
      setIsSaving(false);
      setIsEditing(false);
    }
  };

  const suggest = async (e) => {
    e.stopPropagation();
    setIsGenerating(true);
    try {
      const transcriptText = transcriptToText(segments);
      if (transcriptText.trim().length < 50) {
        addToast('Not enough conversation yet to suggest a title', 'info');
        return;
      }
      const res = await fetch('/api/ai/title-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ transcript: transcriptText, currentTitle: title, model: getPreferredAiModel() }),
      });
      const data = await res.json().catch(() => null);
      // Only open the editor with a real title: an empty one used to crash on save
      if (res.ok && typeof data?.title === 'string' && data.title.trim()) {
        setEditedTitle(data.title.trim());
        setIsEditing(true);
      } else {
        addToast(data?.error || 'Failed to generate title', 'error');
      }
    } catch {
      addToast('Failed to generate title', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  if (!canEdit) {
    return <h1 className="text-serif text-lg meeting-title">{title}</h1>;
  }

  if (isEditing) {
    return (
      <div className="title-edit-row">
        <input
          type="text"
          className="input title-edit-input text-serif text-lg"
          aria-label="Meeting title"
          value={editedTitle}
          onChange={(e) => setEditedTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          autoFocus
          onFocus={(e) => e.target.select()}
        />
        <Button variant="ghost" size="icon" onClick={save} disabled={isSaving} aria-label="Save title">
          {isSaving ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setIsEditing(false)} disabled={isSaving} aria-label="Cancel">
          <X size={16} />
        </Button>
      </div>
    );
  }

  return (
    <div className="title-display" onClick={startEditing}>
      <h1 className="text-serif text-lg meeting-title">{title}</h1>
      <Pencil size={16} className="title-action text-muted" aria-hidden="true" />
      <button
        className="title-action-btn"
        onClick={suggest}
        disabled={isGenerating}
        title="Suggest a title with AI"
        aria-label="Suggest a title with AI"
      >
        {isGenerating
          ? <Loader2 size={16} className="spin text-muted" />
          : <Sparkles size={16} className="title-action text-muted" />}
      </button>
    </div>
  );
}
