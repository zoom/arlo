import React, { useState } from 'react';
import { Users, Clock, MessageSquare } from 'lucide-react';
import Card from '../../components/ui/Card';
import './ParticipantStats.css';

/**
 * ParticipantStats — Talk time and participation breakdown.
 *
 * Shows who spoke, for how long, and participation balance.
 */

// Demo participant data
const DEMO_PARTICIPANTS = [
  { id: 1, name: 'Sarah Chen', talkTime: 480, segments: 28, color: '#8b5cf6' },
  { id: 2, name: 'Mike Johnson', talkTime: 320, segments: 22, color: '#2563eb' },
  { id: 3, name: 'Alex Rivera', talkTime: 180, segments: 15, color: '#0891b2' },
  { id: 4, name: 'You', talkTime: 240, segments: 18, color: '#22c55e' },
];

export default function ParticipantStats({ segments }) {
  const [participants] = useState(DEMO_PARTICIPANTS);

  const totalTalkTime = participants.reduce((sum, p) => sum + p.talkTime, 0);
  const totalSegments = participants.reduce((sum, p) => sum + p.segments, 0);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  };

  // Sort by talk time descending
  const sortedParticipants = [...participants].sort((a, b) => b.talkTime - a.talkTime);

  return (
    <Card className="participant-stats">
      <div className="participant-stats-header">
        <div className="participant-stats-title">
          <Users size={18} className="participant-stats-icon" />
          <h3 className="text-serif font-medium">Participation</h3>
        </div>
        <div className="participant-stats-summary text-xs text-muted">
          <span>{participants.length} participants</span>
          <span className="participant-stats-dot" />
          <span>{formatTime(totalTalkTime)} total</span>
        </div>
      </div>

      {/* Visual bar representation */}
      <div className="participant-bar">
        {sortedParticipants.map(p => (
          <div
            key={p.id}
            className="participant-bar-segment"
            style={{
              width: `${(p.talkTime / totalTalkTime) * 100}%`,
              background: p.color,
            }}
            title={`${p.name}: ${formatTime(p.talkTime)}`}
          />
        ))}
      </div>

      {/* Participant list */}
      <div className="participant-list">
        {sortedParticipants.map((p, index) => {
          const percentage = Math.round((p.talkTime / totalTalkTime) * 100);
          return (
            <div key={p.id} className="participant-item">
              <div className="participant-rank">
                {index + 1}
              </div>
              <div
                className="participant-color"
                style={{ background: p.color }}
              />
              <div className="participant-info">
                <span className="participant-name text-sm font-medium">
                  {p.name}
                </span>
                <div className="participant-meta">
                  <span className="participant-time text-xs text-muted">
                    <Clock size={10} />
                    {formatTime(p.talkTime)}
                  </span>
                  <span className="participant-segments text-xs text-muted">
                    <MessageSquare size={10} />
                    {p.segments}
                  </span>
                </div>
              </div>
              <div className="participant-percentage text-sm font-medium" style={{ color: p.color }}>
                {percentage}%
              </div>
            </div>
          );
        })}
      </div>

      {/* Balance indicator */}
      <div className="participant-balance">
        <span className="participant-balance-label text-xs text-muted">
          Participation Balance
        </span>
        <div className="participant-balance-indicator">
          {(() => {
            const maxPercent = Math.round((sortedParticipants[0]?.talkTime / totalTalkTime) * 100);
            const minPercent = Math.round((sortedParticipants[sortedParticipants.length - 1]?.talkTime / totalTalkTime) * 100);
            const diff = maxPercent - minPercent;
            const isBalanced = diff < 20;
            return (
              <>
                <div className={`balance-bar ${isBalanced ? 'balanced' : 'unbalanced'}`}>
                  <div className="balance-fill" style={{ width: `${100 - diff}%` }} />
                </div>
                <span className={`balance-label text-xs ${isBalanced ? 'balanced' : 'unbalanced'}`}>
                  {isBalanced ? 'Well balanced' : 'Could be more balanced'}
                </span>
              </>
            );
          })()}
        </div>
      </div>
    </Card>
  );
}
