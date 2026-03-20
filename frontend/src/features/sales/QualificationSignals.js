import React, { useState } from 'react';
import { ClipboardCheck, Check, X, HelpCircle, DollarSign, UserCheck, Zap, Clock, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import './QualificationSignals.css';

/**
 * QualificationSignals — Track deal qualification during sales calls.
 *
 * Criteria: Budget, Authority, Need, Timeline
 * Detects qualification signals from conversation and allows manual updates.
 */

const QUALIFICATION_CRITERIA = [
  {
    id: 'budget',
    label: 'Budget',
    icon: DollarSign,
    description: 'Has budget or can get budget approved',
    questions: [
      'What budget have you allocated for this?',
      'Who controls the budget for this project?',
      'What was the budget for your current solution?',
    ],
  },
  {
    id: 'authority',
    label: 'Authority',
    icon: UserCheck,
    description: 'Decision maker or access to decision maker',
    questions: [
      'Who else is involved in making this decision?',
      'What does your approval process look like?',
      'Who signs off on purchases like this?',
    ],
  },
  {
    id: 'need',
    label: 'Need',
    icon: Zap,
    description: 'Clear pain point or business need identified',
    questions: [
      'What challenges are you trying to solve?',
      'What happens if you don\'t solve this problem?',
      'How is this impacting your business today?',
    ],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: Clock,
    description: 'Defined timeline or urgency to implement',
    questions: [
      'When do you need to have this in place?',
      'What\'s driving your timeline?',
      'Are there any deadlines we should be aware of?',
    ],
  },
];

const STATUS_CONFIG = {
  confirmed: { icon: Check, color: '#10b981', label: 'Confirmed' },
  unclear: { icon: HelpCircle, color: '#f59e0b', label: 'Unclear' },
  missing: { icon: X, color: '#ef4444', label: 'Missing' },
  unknown: { icon: HelpCircle, color: '#6b7280', label: 'Not Discussed' },
};

// Demo qualification data — Meridian Financial Group deal
const DEMO_SIGNALS = {
  budget: {
    status: 'confirmed',
    signals: [
      { text: 'We have $250K allocated for this project in FY26', timestamp: '10:28:45 AM', seqNo: 52, sentiment: 'positive' },
      { text: 'Budget was pre-approved as part of our digital transformation initiative', timestamp: '10:35:12 AM', seqNo: 62, sentiment: 'positive' },
    ],
    notes: 'Strong budget position. Our $248K proposal fits within their allocation.',
  },
  authority: {
    status: 'unclear',
    signals: [
      { text: 'James (VP Data Analytics) is leading the evaluation and will make the recommendation', timestamp: '10:12:22 AM', seqNo: 22, sentiment: 'positive' },
      { text: 'Rachel (CTO) has final sign-off authority on anything over $100K', timestamp: '10:55:33 AM', seqNo: 98, sentiment: 'neutral' },
      { text: 'Kevin in procurement will handle the contract once we get technical approval', timestamp: '11:15:22 AM', seqNo: 128, sentiment: 'positive' },
    ],
    notes: 'James is strong champion. Need executive meeting with Rachel (CTO) to close. Kevin (Procurement) is aligned.',
  },
  need: {
    status: 'confirmed',
    signals: [
      { text: 'Our current Oracle system can\'t handle the real-time analytics requirements', timestamp: '10:08:22 AM', seqNo: 15, sentiment: 'positive' },
      { text: 'We\'re losing competitive bids because we can\'t produce risk assessments fast enough', timestamp: '10:22:18 AM', seqNo: 42, sentiment: 'positive' },
      { text: 'The data team is spending 30% of their time on manual data prep', timestamp: '10:38:45 AM', seqNo: 68, sentiment: 'positive' },
    ],
    notes: 'Critical business pain: slow analytics = lost deals. Oracle contract expiring June. Strong urgency.',
  },
  timeline: {
    status: 'confirmed',
    signals: [
      { text: 'Our Oracle contract expires June 30, so we need to be live by then', timestamp: '10:55:18 AM', seqNo: 98, sentiment: 'positive' },
      { text: 'We want to start implementation by end of April to hit that June deadline', timestamp: '11:08:45 AM', seqNo: 118, sentiment: 'positive' },
    ],
    notes: 'Hard deadline: Oracle contract expiration June 30. Decision needed by end of March to start April implementation.',
  },
};

export default function QualificationSignals({ segments, onJumpToSegment }) {
  const [signals, setSignals] = useState(DEMO_SIGNALS);
  const [expandedId, setExpandedId] = useState('need');
  const [showQuestions, setShowQuestions] = useState(null);

  // Calculate overall qualification score
  const confirmedCount = Object.values(signals).filter(s => s.status === 'confirmed').length;
  const score = Math.round((confirmedCount / 4) * 100);

  const updateStatus = (criteriaId, newStatus) => {
    setSignals(prev => ({
      ...prev,
      [criteriaId]: { ...prev[criteriaId], status: newStatus },
    }));
  };

  const getScoreColor = () => {
    if (score >= 75) return '#10b981';
    if (score >= 50) return '#f59e0b';
    return '#ef4444';
  };

  return (
    <Card className="qualification-signals">
      <div className="qualification-header">
        <div className="qualification-title">
          <ClipboardCheck size={18} className="qualification-icon" />
          <h3 className="text-serif font-medium">Deal Qualification</h3>
        </div>
        <div className="qualification-score" style={{ '--score-color': getScoreColor() }}>
          <div className="qualification-score-ring">
            <svg viewBox="0 0 36 36">
              <path
                className="qualification-score-bg"
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <path
                className="qualification-score-fill"
                strokeDasharray={`${score}, 100`}
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <span className="qualification-score-value">{score}%</span>
          </div>
        </div>
      </div>

      {/* BANT Criteria */}
      <div className="qualification-criteria">
        {QUALIFICATION_CRITERIA.map(criteria => {
          const signal = signals[criteria.id];
          const statusConfig = STATUS_CONFIG[signal?.status || 'unknown'];
          const StatusIcon = statusConfig.icon;
          const CriteriaIcon = criteria.icon;
          const isExpanded = expandedId === criteria.id;

          return (
            <div key={criteria.id} className={`qualification-item ${signal?.status || 'unknown'}`}>
              <button
                className="qualification-item-header"
                onClick={() => setExpandedId(isExpanded ? null : criteria.id)}
              >
                <div className="qualification-item-left">
                  <CriteriaIcon size={16} className="qualification-criteria-icon" />
                  <span className="qualification-criteria-label font-medium">{criteria.label}</span>
                </div>
                <div className="qualification-item-right">
                  <div
                    className="qualification-status"
                    style={{ color: statusConfig.color }}
                  >
                    <StatusIcon size={14} />
                    <span className="text-xs">{statusConfig.label}</span>
                  </div>
                  {signal?.signals?.length > 0 && (
                    <span className="qualification-signal-count">
                      {signal.signals.length}
                    </span>
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="qualification-item-content">
                  {/* Status selector */}
                  <div className="qualification-status-selector">
                    {Object.entries(STATUS_CONFIG).filter(([key]) => key !== 'unknown').map(([key, config]) => (
                      <button
                        key={key}
                        className={`qualification-status-btn ${signal?.status === key ? 'active' : ''}`}
                        style={{ '--status-color': config.color }}
                        onClick={() => updateStatus(criteria.id, key)}
                      >
                        <config.icon size={12} />
                        {config.label}
                      </button>
                    ))}
                  </div>

                  {/* Detected signals */}
                  {signal?.signals?.length > 0 && (
                    <div className="qualification-signals-list">
                      <span className="qualification-signals-label text-xs text-muted">
                        Detected Signals
                      </span>
                      {signal.signals.map((s, i) => (
                        <button
                          key={i}
                          className="qualification-signal"
                          onClick={() => onJumpToSegment?.(s.seqNo)}
                        >
                          <span className="qualification-signal-text text-sm">"{s.text}"</span>
                          <span className="qualification-signal-time text-mono text-xs">{s.timestamp}</span>
                          <ExternalLink size={10} className="qualification-signal-link" />
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Notes */}
                  {signal?.notes && (
                    <div className="qualification-notes">
                      <span className="qualification-notes-label text-xs text-muted">Notes</span>
                      <p className="qualification-notes-text text-sm">{signal.notes}</p>
                    </div>
                  )}

                  {/* Discovery questions */}
                  <button
                    className="qualification-questions-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowQuestions(showQuestions === criteria.id ? null : criteria.id);
                    }}
                  >
                    <HelpCircle size={12} />
                    <span className="text-xs">Discovery Questions</span>
                  </button>

                  {showQuestions === criteria.id && (
                    <div className="qualification-questions">
                      {criteria.questions.map((q, i) => (
                        <p key={i} className="qualification-question text-sm">• {q}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
