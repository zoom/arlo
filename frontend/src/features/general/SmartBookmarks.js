import React, { useState } from 'react';
import { Bookmark, Flag, AlertCircle, Lightbulb, Star, Clock, X, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import './SmartBookmarks.css';

/**
 * SmartBookmarks — Quick one-click bookmarking with categories.
 *
 * Allows marking moments in the transcript with predefined categories.
 */

const BOOKMARK_TYPES = [
  { id: 'important', icon: Flag, label: 'Important', color: '#ef4444' },
  { id: 'followup', icon: Clock, label: 'Follow Up', color: '#f97316' },
  { id: 'idea', icon: Lightbulb, label: 'Idea', color: '#eab308' },
  { id: 'favorite', icon: Star, label: 'Favorite', color: '#8b5cf6' },
];

// Demo bookmarks
const DEMO_BOOKMARKS = [
  { id: 1, type: 'important', note: 'Budget approval announcement', timestamp: '10:12:34 AM', seqNo: 45 },
  { id: 2, type: 'idea', note: 'Consider async standups', timestamp: '10:22:18 AM', seqNo: 68 },
  { id: 3, type: 'followup', note: 'Check with finance on timeline', timestamp: '10:28:55 AM', seqNo: 82 },
];

export default function SmartBookmarks({ segments, onJumpToSegment, currentSeqNo }) {
  const [bookmarks, setBookmarks] = useState(DEMO_BOOKMARKS);
  const [quickNote, setQuickNote] = useState('');

  const addBookmark = (type) => {
    const bookmark = {
      id: Date.now(),
      type,
      note: quickNote || `Marked at ${new Date().toLocaleTimeString()}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
      seqNo: currentSeqNo || null,
    };
    setBookmarks(prev => [bookmark, ...prev]);
    setQuickNote('');
  };

  const removeBookmark = (id) => {
    setBookmarks(prev => prev.filter(b => b.id !== id));
  };

  return (
    <Card className="smart-bookmarks">
      <div className="smart-bookmarks-header">
        <div className="smart-bookmarks-title">
          <Bookmark size={18} className="smart-bookmarks-icon" />
          <h3 className="text-serif font-medium">Bookmarks</h3>
          <span className="smart-bookmarks-count">{bookmarks.length}</span>
        </div>
      </div>

      {/* Quick bookmark buttons */}
      <div className="smart-bookmarks-quick">
        <input
          type="text"
          className="smart-bookmarks-input"
          placeholder="Quick note (optional)..."
          value={quickNote}
          onChange={(e) => setQuickNote(e.target.value)}
        />
        <div className="smart-bookmarks-buttons">
          {BOOKMARK_TYPES.map(type => {
            const Icon = type.icon;
            return (
              <button
                key={type.id}
                className="smart-bookmark-btn"
                style={{ '--bookmark-color': type.color }}
                onClick={() => addBookmark(type.id)}
                title={`Add ${type.label} bookmark`}
              >
                <Icon size={14} />
                <span className="smart-bookmark-label">{type.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Bookmark list */}
      <div className="smart-bookmarks-list">
        {bookmarks.length === 0 ? (
          <p className="smart-bookmarks-empty text-sm text-muted">
            No bookmarks yet
          </p>
        ) : (
          bookmarks.map(bookmark => {
            const typeConfig = BOOKMARK_TYPES.find(t => t.id === bookmark.type);
            const Icon = typeConfig?.icon || Bookmark;
            return (
              <div
                key={bookmark.id}
                className="smart-bookmark-item"
                style={{ '--bookmark-color': typeConfig?.color }}
              >
                <div className="smart-bookmark-icon">
                  <Icon size={12} />
                </div>
                <div className="smart-bookmark-content">
                  <span className="smart-bookmark-note text-sm">{bookmark.note}</span>
                  <span className="smart-bookmark-time text-mono text-xs text-muted">
                    {bookmark.timestamp}
                  </span>
                </div>
                <div className="smart-bookmark-actions">
                  {bookmark.seqNo && (
                    <button
                      className="smart-bookmark-jump"
                      onClick={() => onJumpToSegment?.(bookmark.seqNo)}
                    >
                      <ExternalLink size={12} />
                    </button>
                  )}
                  <button
                    className="smart-bookmark-remove"
                    onClick={() => removeBookmark(bookmark.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
