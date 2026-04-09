import React, { useState } from 'react';
import { GitBranch, Plus, ExternalLink, X, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './DecisionsLog.css';

/**
 * DecisionsLog — Track decisions made during the meeting.
 *
 * Auto-detects decisions and allows manual additions.
 */

// Demo decisions — Product team Q2 planning meeting
const DEMO_DECISIONS = [
  {
    id: 1,
    text: 'Mobile app v1.0 is Q2 priority #1 — targeting April 15 beta release',
    madeBy: 'Priya Sharma',
    timestamp: '10:08:15 AM',
    seqNo: 22,
    isAutoDetected: true,
  },
  {
    id: 2,
    text: 'Launch with basic checkout first; add full payment gateway integration in May update',
    madeBy: 'Team consensus',
    timestamp: '10:22:18 AM',
    seqNo: 62,
    isAutoDetected: true,
  },
  {
    id: 3,
    text: 'AI recommendations feature pushed to late Q2 (after mobile launch stabilizes)',
    madeBy: 'Priya Sharma',
    timestamp: '10:25:33 AM',
    seqNo: 72,
    isAutoDetected: true,
  },
  {
    id: 4,
    text: 'New engineer Raj starts March 25 — will lead mobile backend work',
    madeBy: 'Morgan Chen',
    timestamp: '10:32:18 AM',
    seqNo: 88,
    isAutoDetected: true,
  },
  {
    id: 5,
    text: 'Weekly mobile standup starting next Monday, 9am',
    madeBy: 'Jordan Kim',
    timestamp: '10:38:45 AM',
    seqNo: 102,
    isAutoDetected: false,
  },
];

export default function DecisionsLog({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('decisions-log');
  const [decisions, setDecisions] = useState(showDemoData ? DEMO_DECISIONS : []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newDecision, setNewDecision] = useState('');

  const addDecision = () => {
    if (!newDecision.trim()) return;
    const decision = {
      id: Date.now(),
      text: newDecision.trim(),
      madeBy: 'You',
      timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
      seqNo: null,
      isAutoDetected: false,
    };
    setDecisions(prev => [...prev, decision]);
    setNewDecision('');
    setShowAddForm(false);
  };

  const removeDecision = (id) => {
    setDecisions(prev => prev.filter(d => d.id !== id));
  };

  return (
    <Card className={`decisions-log ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="decisions-log-header feature-collapse-header"
        onClick={() => toggleCollapsed('decisions-log')}
        aria-expanded={!collapsed}
      >
        <div className="decisions-log-title">
          <GitBranch size={18} className="decisions-log-icon" />
          <h3 className="text-serif font-medium">Decisions</h3>
          <span className="decisions-log-count">{decisions.length}</span>
        </div>
        <div className="feature-header-right">
          {!collapsed && (
            <button
              className="decisions-log-add-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowAddForm(!showAddForm);
              }}
            >
              <Plus size={16} />
            </button>
          )}
          {collapsed ? (
            <ChevronDown size={16} className="feature-chevron" />
          ) : (
            <ChevronUp size={16} className="feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && showAddForm && (
        <div className="decisions-log-add-form">
          <Input
            placeholder="Enter decision..."
            value={newDecision}
            onChange={(e) => setNewDecision(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addDecision()}
            autoFocus
          />
          <div className="decisions-log-add-actions">
            <button className="decisions-add-btn" onClick={addDecision}>Add</button>
            <button className="decisions-cancel-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!collapsed && (
      <div className="decisions-log-list">
        {decisions.length === 0 ? (
          <p className="decisions-log-empty text-sm text-muted">
            No decisions captured yet
          </p>
        ) : (
          decisions.map(decision => (
            <div key={decision.id} className="decision-item">
              <div className="decision-content">
                <p className="decision-text text-sm">{decision.text}</p>
                <div className="decision-meta">
                  <span className="decision-by text-xs text-muted">
                    {decision.madeBy}
                  </span>
                  <span className="decision-time text-mono text-xs text-muted">
                    {decision.timestamp}
                  </span>
                  {decision.isAutoDetected && (
                    <span className="decision-auto text-xs">Auto</span>
                  )}
                </div>
              </div>
              <div className="decision-actions">
                {decision.seqNo && (
                  <button
                    className="decision-jump"
                    onClick={() => onJumpToSegment?.(decision.seqNo)}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                <button
                  className="decision-remove"
                  onClick={() => removeDecision(decision.id)}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      )}
    </Card>
  );
}
