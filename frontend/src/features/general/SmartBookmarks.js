import React, { useState } from 'react';
import { Bookmark, Flag, AlertCircle, Lightbulb, Star, Clock, X, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
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

// Demo bookmarks — Product team Q2 planning meeting
const DEMO_BOOKMARKS = [
  { id: 1, type: 'important', note: 'Mobile app officially Q2 priority #1', timestamp: '10:08:15 AM', seqNo: 22 },
  { id: 2, type: 'followup', note: 'Check Stripe sandbox status with Marcus', timestamp: '10:15:42 AM', seqNo: 45 },
  { id: 3, type: 'idea', note: 'Apple Pay first, Stripe later — phased approach', timestamp: '10:18:33 AM', seqNo: 52 },
  { id: 4, type: 'favorite', note: 'Design specs shipping tomorrow!', timestamp: '10:28:45 AM', seqNo: 78 },
];

export default function SmartBookmarks({ segments, onJumpToSegment, currentSeqNo, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('smart-bookmarks');
  const [bookmarks, setBookmarks] = useState(showDemoData ? DEMO_BOOKMARKS : []);
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
    <Card className={`smart-bookmarks ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="smart-bookmarks-header feature-collapse-header"
        onClick={() => toggleCollapsed('smart-bookmarks')}
        aria-expanded={!collapsed}
      >
        <div className="smart-bookmarks-title">
          <Bookmark size={18} className="smart-bookmarks-icon" />
          <h3 className="text-serif font-medium">Bookmarks</h3>
          <span className="smart-bookmarks-count">{bookmarks.length}</span>
        </div>
        <div className="feature-header-right">
          {collapsed ? (
            <ChevronDown size={16} className="feature-chevron" />
          ) : (
            <ChevronUp size={16} className="feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && (
      <>
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
      </>
      )}
    </Card>
  );
}
