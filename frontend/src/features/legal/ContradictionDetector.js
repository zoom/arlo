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

// Demo contradictions for testing — Employment discrimination case
const DEMO_CONTRADICTIONS = [
  {
    id: 1,
    severity: 'high',
    category: 'Timeline',
    description: 'Conflicting statements about when performance issues were first raised',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'We first discussed performance concerns with Mr. Thompson in January, during his annual review.',
        timestamp: '10:18:22 AM',
        seqNo: 35,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'The performance improvement plan was actually the first formal conversation we had about any issues, that was in March.',
        timestamp: '10:52:17 AM',
        seqNo: 94,
      },
    ],
    status: 'flagged', // flagged, noted, dismissed
  },
  {
    id: 2,
    severity: 'high',
    category: 'Key Fact',
    description: 'Inconsistent account of who made the termination decision',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'The decision to terminate was made by the executive team. I was just implementing their decision.',
        timestamp: '10:31:45 AM',
        seqNo: 58,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'I recommended termination based on my assessment of the situation.',
        timestamp: '11:08:33 AM',
        seqNo: 118,
      },
    ],
    status: 'flagged',
  },
  {
    id: 3,
    severity: 'high',
    category: 'Key Fact',
    description: 'Conflicting statements about awareness of protected status',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'I had no idea Mr. Thompson had filed an EEOC complaint until after he was terminated.',
        timestamp: '10:42:08 AM',
        seqNo: 78,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'Legal had informed HR about the complaint, but that didn\'t factor into our decision at all.',
        timestamp: '11:22:41 AM',
        seqNo: 142,
      },
    ],
    status: 'flagged',
  },
  {
    id: 4,
    severity: 'medium',
    category: 'Documentation',
    description: 'Different accounts of when PIP documentation was created',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'The PIP was drafted in late February after several verbal warnings.',
        timestamp: '10:25:12 AM',
        seqNo: 48,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'We created the formal documentation in March, right before presenting it to him.',
        timestamp: '11:15:20 AM',
        seqNo: 132,
      },
    ],
    status: 'noted',
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
