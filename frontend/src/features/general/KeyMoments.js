import React, { useState } from 'react';
import { Zap, ExternalLink, Star, StarOff } from 'lucide-react';
import Card from '../../components/ui/Card';
import './KeyMoments.css';

/**
 * KeyMoments — Auto-detected important moments in the meeting.
 *
 * Highlights significant statements, announcements, and turning points.
 */

const MOMENT_TYPES = {
  announcement: { label: 'Announcement', color: '#8b5cf6' },
  agreement: { label: 'Agreement', color: '#22c55e' },
  concern: { label: 'Concern', color: '#f97316' },
  insight: { label: 'Insight', color: '#2563eb' },
  milestone: { label: 'Milestone', color: '#ec4899' },
};

// Demo moments
const DEMO_MOMENTS = [
  {
    id: 1,
    type: 'announcement',
    text: '"We\'ve decided to move forward with the new dashboard design"',
    speaker: 'Sarah Chen',
    timestamp: '10:12:34 AM',
    seqNo: 45,
    starred: true,
  },
  {
    id: 2,
    type: 'agreement',
    text: '"Everyone agrees the API changes should be prioritized"',
    speaker: 'Meeting consensus',
    timestamp: '10:18:22 AM',
    seqNo: 62,
    starred: false,
  },
  {
    id: 3,
    type: 'concern',
    text: '"I\'m worried about the timeline being too aggressive"',
    speaker: 'Mike Johnson',
    timestamp: '10:25:15 AM',
    seqNo: 78,
    starred: false,
  },
  {
    id: 4,
    type: 'milestone',
    text: '"Budget has been officially approved by finance"',
    speaker: 'Sarah Chen',
    timestamp: '10:32:41 AM',
    seqNo: 95,
    starred: true,
  },
];

export default function KeyMoments({ segments, onJumpToSegment }) {
  const [moments, setMoments] = useState(DEMO_MOMENTS);

  const toggleStar = (momentId) => {
    setMoments(prev => prev.map(m =>
      m.id === momentId ? { ...m, starred: !m.starred } : m
    ));
  };

  const starredCount = moments.filter(m => m.starred).length;

  return (
    <Card className="key-moments">
      <div className="key-moments-header">
        <div className="key-moments-title">
          <Zap size={18} className="key-moments-icon" />
          <h3 className="text-serif font-medium">Key Moments</h3>
          <span className="key-moments-count">{moments.length}</span>
        </div>
        {starredCount > 0 && (
          <span className="key-moments-starred text-xs">
            <Star size={12} />
            {starredCount} starred
          </span>
        )}
      </div>

      <div className="key-moments-list">
        {moments.map(moment => {
          const config = MOMENT_TYPES[moment.type];
          return (
            <button
              key={moment.id}
              className="key-moment"
              onClick={() => onJumpToSegment?.(moment.seqNo)}
            >
              <div className="key-moment-header">
                <span
                  className="key-moment-type text-xs font-medium"
                  style={{ color: config.color }}
                >
                  {config.label}
                </span>
                <span className="key-moment-time text-mono text-xs">
                  {moment.timestamp}
                </span>
              </div>
              <p className="key-moment-text text-sm">{moment.text}</p>
              <div className="key-moment-footer">
                <span className="key-moment-speaker text-xs text-muted">
                  {moment.speaker}
                </span>
                <div className="key-moment-actions">
                  <button
                    className={`key-moment-star ${moment.starred ? 'starred' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleStar(moment.id);
                    }}
                  >
                    {moment.starred ? <Star size={14} /> : <StarOff size={14} />}
                  </button>
                  <ExternalLink size={12} className="key-moment-link" />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
