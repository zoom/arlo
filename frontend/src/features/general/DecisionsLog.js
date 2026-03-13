import React, { useState } from 'react';
import { GitBranch, Plus, ExternalLink, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import './DecisionsLog.css';

/**
 * DecisionsLog — Track decisions made during the meeting.
 *
 * Auto-detects decisions and allows manual additions.
 */

// Demo decisions
const DEMO_DECISIONS = [
  {
    id: 1,
    text: 'Move forward with dashboard redesign for Q2',
    madeBy: 'Sarah Chen',
    timestamp: '10:12:34 AM',
    seqNo: 45,
    isAutoDetected: true,
  },
  {
    id: 2,
    text: 'Prioritize API rate limiting over new features',
    madeBy: 'Team consensus',
    timestamp: '10:18:22 AM',
    seqNo: 62,
    isAutoDetected: true,
  },
  {
    id: 3,
    text: 'Schedule follow-up meeting for next Tuesday',
    madeBy: 'Mike Johnson',
    timestamp: '10:35:18 AM',
    seqNo: 98,
    isAutoDetected: false,
  },
];

export default function DecisionsLog({ segments, onJumpToSegment }) {
  const [decisions, setDecisions] = useState(DEMO_DECISIONS);
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
    <Card className="decisions-log">
      <div className="decisions-log-header">
        <div className="decisions-log-title">
          <GitBranch size={18} className="decisions-log-icon" />
          <h3 className="text-serif font-medium">Decisions</h3>
          <span className="decisions-log-count">{decisions.length}</span>
        </div>
        <button
          className="decisions-log-add-btn"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          <Plus size={16} />
        </button>
      </div>

      {showAddForm && (
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
    </Card>
  );
}
