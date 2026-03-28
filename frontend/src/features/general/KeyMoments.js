import React, { useState } from 'react';
import { Zap, ExternalLink, Star, StarOff, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
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

// Demo moments — Product team Q2 planning meeting
const DEMO_MOMENTS = [
  {
    id: 1,
    type: 'announcement',
    text: '"Mobile app is officially our number one priority for Q2"',
    speaker: 'Priya Sharma (Product Director)',
    timestamp: '10:08:15 AM',
    seqNo: 22,
    starred: true,
  },
  {
    id: 2,
    type: 'concern',
    text: '"The Stripe integration is at risk — their sandbox has been unreliable and our timeline depends on it"',
    speaker: 'Marcus Chen (Lead Engineer)',
    timestamp: '10:15:42 AM',
    seqNo: 45,
    starred: true,
  },
  {
    id: 3,
    type: 'insight',
    text: '"What if we launch with Apple Pay only first? That integration is already stable"',
    speaker: 'Jordan Kim (Product Manager)',
    timestamp: '10:18:33 AM',
    seqNo: 52,
    starred: false,
  },
  {
    id: 4,
    type: 'agreement',
    text: '"Let\'s do phased payments: Apple Pay at launch, full Stripe in the May update"',
    speaker: 'Team consensus',
    timestamp: '10:22:18 AM',
    seqNo: 62,
    starred: false,
  },
  {
    id: 5,
    type: 'milestone',
    text: '"Design approved the final mobile mockups — they\'re shipping specs to engineering tomorrow"',
    speaker: 'Ava Martinez (Lead Designer)',
    timestamp: '10:28:45 AM',
    seqNo: 78,
    starred: true,
  },
];

export default function KeyMoments({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('key-moments');
  const [moments, setMoments] = useState(showDemoData ? DEMO_MOMENTS : []);

  const toggleStar = (momentId) => {
    setMoments(prev => prev.map(m =>
      m.id === momentId ? { ...m, starred: !m.starred } : m
    ));
  };

  const starredCount = moments.filter(m => m.starred).length;

  return (
    <Card className={`key-moments ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="key-moments-header feature-collapse-header"
        onClick={() => toggleCollapsed('key-moments')}
        aria-expanded={!collapsed}
      >
        <div className="key-moments-title">
          <Zap size={18} className="key-moments-icon" />
          <h3 className="text-serif font-medium">Key Moments</h3>
          <span className="feature-live-badge">Live</span>
          <span className="key-moments-count">{moments.length}</span>
        </div>
        <div className="feature-header-right">
          {starredCount > 0 && !collapsed && (
            <span className="key-moments-starred text-xs">
              <Star size={12} />
              {starredCount} starred
            </span>
          )}
          {collapsed ? (
            <ChevronDown size={16} className="feature-chevron" />
          ) : (
            <ChevronUp size={16} className="feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && (
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
      )}
    </Card>
  );
}
