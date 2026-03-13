import React, { useState } from 'react';
import { CheckCircle2, Circle, Clock, User, Building2, Plus, ExternalLink, Calendar } from 'lucide-react';
import Card from '../../components/ui/Card';
import './CommitmentsPanel.css';

/**
 * CommitmentsPanel — Track next steps and commitments from sales calls.
 *
 * Features:
 * - Auto-detected action items from conversation
 * - Owner assignment (us vs. them)
 * - Due date tracking
 * - Mark as complete
 * - Link to transcript context
 */

// Demo commitments data
const DEMO_COMMITMENTS = [
  {
    id: 1,
    text: 'Send over the security documentation and SOC 2 report',
    owner: 'us',
    ownerName: 'You',
    dueDate: '2024-03-18',
    status: 'pending',
    timestamp: '10:23:45 AM',
    seqNo: 42,
    autoDetected: true,
  },
  {
    id: 2,
    text: 'Schedule follow-up demo with the engineering team',
    owner: 'us',
    ownerName: 'You',
    dueDate: '2024-03-20',
    status: 'pending',
    timestamp: '10:35:12 AM',
    seqNo: 58,
    autoDetected: true,
  },
  {
    id: 3,
    text: 'Get budget approval from finance',
    owner: 'them',
    ownerName: 'Sarah Chen',
    dueDate: '2024-03-22',
    status: 'pending',
    timestamp: '10:42:33 AM',
    seqNo: 72,
    autoDetected: true,
  },
  {
    id: 4,
    text: 'Review the proposal with the CTO',
    owner: 'them',
    ownerName: 'Sarah Chen',
    dueDate: '2024-03-25',
    status: 'pending',
    timestamp: '10:51:18 AM',
    seqNo: 89,
    autoDetected: true,
  },
  {
    id: 5,
    text: 'Prepare custom pricing proposal',
    owner: 'us',
    ownerName: 'You',
    dueDate: '2024-03-15',
    status: 'completed',
    timestamp: '10:15:22 AM',
    seqNo: 28,
    autoDetected: false,
  },
];

export default function CommitmentsPanel({ segments, onJumpToSegment }) {
  const [commitments, setCommitments] = useState(DEMO_COMMITMENTS);
  const [filter, setFilter] = useState('all'); // all, us, them, completed
  const [isAdding, setIsAdding] = useState(false);
  const [newCommitment, setNewCommitment] = useState({ text: '', owner: 'us', dueDate: '' });

  // Filter commitments
  const filteredCommitments = commitments.filter(c => {
    if (filter === 'all') return c.status !== 'completed';
    if (filter === 'us') return c.owner === 'us' && c.status !== 'completed';
    if (filter === 'them') return c.owner === 'them' && c.status !== 'completed';
    if (filter === 'completed') return c.status === 'completed';
    return true;
  });

  // Counts
  const counts = {
    all: commitments.filter(c => c.status !== 'completed').length,
    us: commitments.filter(c => c.owner === 'us' && c.status !== 'completed').length,
    them: commitments.filter(c => c.owner === 'them' && c.status !== 'completed').length,
    completed: commitments.filter(c => c.status === 'completed').length,
  };

  const toggleComplete = (id) => {
    setCommitments(prev => prev.map(c =>
      c.id === id ? { ...c, status: c.status === 'completed' ? 'pending' : 'completed' } : c
    ));
  };

  const addCommitment = () => {
    if (!newCommitment.text.trim()) return;

    const commitment = {
      id: Date.now(),
      text: newCommitment.text.trim(),
      owner: newCommitment.owner,
      ownerName: newCommitment.owner === 'us' ? 'You' : 'Prospect',
      dueDate: newCommitment.dueDate || null,
      status: 'pending',
      timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }),
      seqNo: segments?.length || 0,
      autoDetected: false,
    };

    setCommitments(prev => [...prev, commitment]);
    setNewCommitment({ text: '', owner: 'us', dueDate: '' });
    setIsAdding(false);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const isOverdue = (dateStr) => {
    if (!dateStr) return false;
    return new Date(dateStr) < new Date();
  };

  return (
    <Card className="commitments-panel">
      <div className="commitments-header">
        <div className="commitments-title">
          <CheckCircle2 size={18} className="commitments-icon" />
          <h3 className="text-serif font-medium">Next Steps</h3>
          <span className="commitments-count">{counts.all}</span>
        </div>

        <button
          className="commitments-add-btn"
          onClick={() => setIsAdding(!isAdding)}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Add new commitment */}
      {isAdding && (
        <div className="commitments-add-form">
          <input
            type="text"
            placeholder="Add commitment or next step..."
            value={newCommitment.text}
            onChange={(e) => setNewCommitment(prev => ({ ...prev, text: e.target.value }))}
            className="commitments-add-input"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && addCommitment()}
          />
          <div className="commitments-add-row">
            <div className="commitments-add-owner">
              <button
                className={`commitments-owner-btn ${newCommitment.owner === 'us' ? 'active' : ''}`}
                onClick={() => setNewCommitment(prev => ({ ...prev, owner: 'us' }))}
              >
                <User size={12} />
                Us
              </button>
              <button
                className={`commitments-owner-btn ${newCommitment.owner === 'them' ? 'active' : ''}`}
                onClick={() => setNewCommitment(prev => ({ ...prev, owner: 'them' }))}
              >
                <Building2 size={12} />
                Them
              </button>
            </div>
            <input
              type="date"
              value={newCommitment.dueDate}
              onChange={(e) => setNewCommitment(prev => ({ ...prev, dueDate: e.target.value }))}
              className="commitments-add-date"
            />
            <button
              className="commitments-add-submit"
              onClick={addCommitment}
              disabled={!newCommitment.text.trim()}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="commitments-filters">
        {[
          { id: 'all', label: 'All' },
          { id: 'us', label: 'Ours', icon: User },
          { id: 'them', label: 'Theirs', icon: Building2 },
          { id: 'completed', label: 'Done' },
        ].map(f => (
          <button
            key={f.id}
            className={`commitments-filter ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.icon && <f.icon size={12} />}
            {f.label}
            {counts[f.id] > 0 && <span className="filter-count">{counts[f.id]}</span>}
          </button>
        ))}
      </div>

      {/* Commitments list */}
      <div className="commitments-list">
        {filteredCommitments.length === 0 ? (
          <p className="commitments-empty text-sm text-muted">
            {filter === 'completed' ? 'No completed items yet.' : 'No next steps tracked yet.'}
          </p>
        ) : (
          filteredCommitments.map(commitment => (
            <div
              key={commitment.id}
              className={`commitment-item ${commitment.status} ${commitment.owner}`}
            >
              <button
                className="commitment-checkbox"
                onClick={() => toggleComplete(commitment.id)}
              >
                {commitment.status === 'completed' ? (
                  <CheckCircle2 size={18} className="commitment-checked" />
                ) : (
                  <Circle size={18} />
                )}
              </button>

              <div className="commitment-content">
                <p className={`commitment-text text-sm ${commitment.status === 'completed' ? 'completed' : ''}`}>
                  {commitment.text}
                </p>
                <div className="commitment-meta">
                  <span className={`commitment-owner ${commitment.owner}`}>
                    {commitment.owner === 'us' ? <User size={10} /> : <Building2 size={10} />}
                    {commitment.ownerName}
                  </span>
                  {commitment.dueDate && (
                    <span className={`commitment-due ${isOverdue(commitment.dueDate) && commitment.status !== 'completed' ? 'overdue' : ''}`}>
                      <Calendar size={10} />
                      {formatDate(commitment.dueDate)}
                    </span>
                  )}
                  {commitment.autoDetected && (
                    <span className="commitment-auto">Auto-detected</span>
                  )}
                </div>
              </div>

              {commitment.seqNo && (
                <button
                  className="commitment-link"
                  onClick={() => onJumpToSegment?.(commitment.seqNo)}
                  title="Jump to context"
                >
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
