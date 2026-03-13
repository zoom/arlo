import React, { useState, useMemo } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Flag, Check, Clock, MessageSquare } from 'lucide-react';
import Card from '../../components/ui/Card';
import './ContradictionDetector.css';

/**
 * ContradictionDetector — Flags potentially conflicting statements in testimony.
 *
 * Helps attorneys identify inconsistencies in depositions, witness statements,
 * and client interviews for impeachment or clarification.
 */

// Demo contradictions for testing
const DEMO_CONTRADICTIONS = [
  {
    id: 1,
    severity: 'high',
    category: 'Timeline',
    description: 'Conflicting statements about when the meeting occurred',
    statements: [
      {
        speaker: 'Witness (John Smith)',
        text: 'The meeting took place on March 15th, I remember because it was right after my birthday.',
        timestamp: '10:23:45 AM',
        seqNo: 42,
      },
      {
        speaker: 'Witness (John Smith)',
        text: 'We met sometime in early April, maybe the first week.',
        timestamp: '10:47:12 AM',
        seqNo: 89,
      },
    ],
    status: 'flagged', // flagged, noted, dismissed
  },
  {
    id: 2,
    severity: 'high',
    category: 'Key Fact',
    description: 'Inconsistent account of who was present',
    statements: [
      {
        speaker: 'Witness (John Smith)',
        text: 'It was just me and Mr. Davis in the room when the document was signed.',
        timestamp: '10:31:22 AM',
        seqNo: 58,
      },
      {
        speaker: 'Witness (John Smith)',
        text: 'Sarah was there too, she witnessed the whole thing.',
        timestamp: '11:02:33 AM',
        seqNo: 112,
      },
    ],
    status: 'flagged',
  },
  {
    id: 3,
    severity: 'medium',
    category: 'Amount/Number',
    description: 'Different figures cited for the contract value',
    statements: [
      {
        speaker: 'Witness (John Smith)',
        text: 'The contract was worth about fifty thousand dollars.',
        timestamp: '10:15:08 AM',
        seqNo: 28,
      },
      {
        speaker: 'Witness (John Smith)',
        text: 'We agreed on seventy-five thousand, that was the final number.',
        timestamp: '10:52:41 AM',
        seqNo: 98,
      },
    ],
    status: 'noted',
  },
  {
    id: 4,
    severity: 'low',
    category: 'Minor Detail',
    description: 'Inconsistent description of location',
    statements: [
      {
        speaker: 'Witness (John Smith)',
        text: 'We met at the downtown office, the one on Main Street.',
        timestamp: '10:12:55 AM',
        seqNo: 22,
      },
      {
        speaker: 'Witness (John Smith)',
        text: 'The meeting was at the conference center near the airport.',
        timestamp: '11:15:20 AM',
        seqNo: 128,
      },
    ],
    status: 'dismissed',
  },
];

const SEVERITY_CONFIG = {
  high: { color: '#dc2626', label: 'High', bgColor: 'rgba(220, 38, 38, 0.1)' },
  medium: { color: '#f59e0b', label: 'Medium', bgColor: 'rgba(245, 158, 11, 0.1)' },
  low: { color: '#6b7280', label: 'Low', bgColor: 'rgba(107, 114, 128, 0.1)' },
};

export default function ContradictionDetector({ segments, onJumpToSegment }) {
  const [contradictions, setContradictions] = useState(DEMO_CONTRADICTIONS);
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all'); // all, flagged, noted, dismissed

  // Filter contradictions
  const filteredContradictions = useMemo(() => {
    if (filter === 'all') return contradictions;
    return contradictions.filter(c => c.status === filter);
  }, [contradictions, filter]);

  // Count by status
  const counts = useMemo(() => ({
    all: contradictions.length,
    flagged: contradictions.filter(c => c.status === 'flagged').length,
    noted: contradictions.filter(c => c.status === 'noted').length,
    dismissed: contradictions.filter(c => c.status === 'dismissed').length,
  }), [contradictions]);

  const updateStatus = (id, newStatus) => {
    setContradictions(prev =>
      prev.map(c => c.id === id ? { ...c, status: newStatus } : c)
    );
  };

  return (
    <div className="contradiction-detector">
      <div className="contradiction-header">
        <div className="contradiction-title">
          <AlertTriangle size={18} className="contradiction-icon" />
          <h3 className="text-serif font-medium">Contradictions</h3>
          {counts.flagged > 0 && (
            <span className="contradiction-badge flagged">{counts.flagged}</span>
          )}
        </div>

        {/* Filter tabs */}
        <div className="contradiction-filters">
          {['all', 'flagged', 'noted', 'dismissed'].map(f => (
            <button
              key={f}
              className={`contradiction-filter ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {counts[f] > 0 && <span className="filter-count">{counts[f]}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="contradiction-list">
        {filteredContradictions.length === 0 ? (
          <p className="contradiction-empty text-sm text-muted">
            No contradictions {filter !== 'all' ? `marked as ${filter}` : 'detected yet'}.
          </p>
        ) : (
          filteredContradictions.map(contradiction => {
            const isExpanded = expandedId === contradiction.id;
            const severityConfig = SEVERITY_CONFIG[contradiction.severity];

            return (
              <Card
                key={contradiction.id}
                className={`contradiction-item ${contradiction.status}`}
                style={{ '--severity-color': severityConfig.color }}
              >
                <button
                  className="contradiction-summary"
                  onClick={() => setExpandedId(isExpanded ? null : contradiction.id)}
                >
                  <span
                    className="contradiction-severity"
                    style={{ background: severityConfig.bgColor, color: severityConfig.color }}
                  >
                    {severityConfig.label}
                  </span>
                  <span className="contradiction-category">{contradiction.category}</span>
                  <span className="contradiction-desc">{contradiction.description}</span>
                  {isExpanded ? (
                    <ChevronUp size={16} className="text-muted" />
                  ) : (
                    <ChevronDown size={16} className="text-muted" />
                  )}
                </button>

                {isExpanded && (
                  <div className="contradiction-details">
                    <div className="contradiction-statements">
                      {contradiction.statements.map((stmt, i) => (
                        <div key={i} className="contradiction-statement">
                          <div className="statement-header">
                            <span className="statement-speaker text-sm font-medium">
                              {stmt.speaker}
                            </span>
                            <button
                              className="statement-timestamp"
                              onClick={() => onJumpToSegment?.(stmt.seqNo)}
                              title="Jump to this statement"
                            >
                              <Clock size={12} />
                              {stmt.timestamp}
                            </button>
                          </div>
                          <p className="statement-text">
                            <MessageSquare size={14} className="statement-quote-icon" />
                            "{stmt.text}"
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="contradiction-actions">
                      <button
                        className={`contradiction-action ${contradiction.status === 'flagged' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'flagged')}
                      >
                        <Flag size={14} />
                        Flag for Follow-up
                      </button>
                      <button
                        className={`contradiction-action ${contradiction.status === 'noted' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'noted')}
                      >
                        <Check size={14} />
                        Mark as Noted
                      </button>
                      <button
                        className={`contradiction-action dismiss ${contradiction.status === 'dismissed' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'dismissed')}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
