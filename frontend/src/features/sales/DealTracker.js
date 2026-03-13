import React, { useState } from 'react';
import { Target, DollarSign, Calendar, Users, TrendingUp, ChevronDown, ChevronUp, Edit2, Check } from 'lucide-react';
import Card from '../../components/ui/Card';
import './DealTracker.css';

/**
 * DealTracker — Track deal/opportunity details during sales calls.
 *
 * Features:
 * - Deal stage progression
 * - Deal value and close date
 * - Key contacts involved
 * - Win probability
 * - Quick edit capabilities
 */

const DEAL_STAGES = [
  { id: 'discovery', label: 'Discovery', color: '#6b7280' },
  { id: 'qualification', label: 'Qualification', color: '#8b5cf6' },
  { id: 'demo', label: 'Demo/Eval', color: '#3b82f6' },
  { id: 'proposal', label: 'Proposal', color: '#f59e0b' },
  { id: 'negotiation', label: 'Negotiation', color: '#f97316' },
  { id: 'closed-won', label: 'Closed Won', color: '#10b981' },
  { id: 'closed-lost', label: 'Closed Lost', color: '#ef4444' },
];

// Demo deal data
const DEMO_DEAL = {
  name: 'Acme Corp - Enterprise License',
  company: 'Acme Corporation',
  value: 75000,
  stage: 'proposal',
  probability: 65,
  closeDate: '2024-04-15',
  contacts: [
    { name: 'Sarah Chen', role: 'VP of Engineering', isPrimary: true },
    { name: 'Mike Johnson', role: 'CTO', isPrimary: false },
    { name: 'Lisa Park', role: 'Procurement', isPrimary: false },
  ],
  notes: 'Strong technical fit. Need to address security concerns before final approval.',
};

export default function DealTracker({ segments, meetingId }) {
  const [deal, setDeal] = useState(DEMO_DEAL);
  const [isExpanded, setIsExpanded] = useState(true);
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState('');

  const currentStageIndex = DEAL_STAGES.findIndex(s => s.id === deal.stage);
  const currentStage = DEAL_STAGES[currentStageIndex];

  const startEdit = (field, value) => {
    setEditingField(field);
    setEditValue(String(value));
  };

  const saveEdit = (field) => {
    setDeal(prev => ({
      ...prev,
      [field]: field === 'value' ? parseInt(editValue, 10) || 0 : editValue,
    }));
    setEditingField(null);
  };

  const updateStage = (stageId) => {
    setDeal(prev => ({ ...prev, stage: stageId }));
  };

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <Card className="deal-tracker">
      <button
        className="deal-tracker-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="deal-tracker-title">
          <Target size={18} className="deal-tracker-icon" />
          <div className="deal-tracker-info">
            <h3 className="text-serif font-medium">{deal.name}</h3>
            <span className="text-xs text-muted">{deal.company}</span>
          </div>
        </div>
        <div className="deal-tracker-summary">
          <span
            className="deal-stage-badge"
            style={{ background: `${currentStage.color}20`, color: currentStage.color }}
          >
            {currentStage.label}
          </span>
          <span className="deal-value">{formatCurrency(deal.value)}</span>
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {isExpanded && (
        <div className="deal-tracker-content">
          {/* Stage Pipeline */}
          <div className="deal-pipeline">
            <span className="deal-section-label text-xs text-muted">Pipeline Stage</span>
            <div className="deal-stages">
              {DEAL_STAGES.slice(0, -1).map((stage, index) => {
                const isActive = stage.id === deal.stage;
                const isPast = index < currentStageIndex;
                const isLost = deal.stage === 'closed-lost';

                return (
                  <button
                    key={stage.id}
                    className={`deal-stage ${isActive ? 'active' : ''} ${isPast ? 'past' : ''} ${isLost ? 'lost' : ''}`}
                    style={{
                      '--stage-color': stage.color,
                    }}
                    onClick={() => updateStage(stage.id)}
                    title={stage.label}
                  >
                    <span className="deal-stage-dot" />
                    <span className="deal-stage-label text-xs">{stage.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Key Metrics */}
          <div className="deal-metrics">
            {/* Deal Value */}
            <div className="deal-metric">
              <DollarSign size={14} className="deal-metric-icon" />
              <span className="deal-metric-label text-xs text-muted">Value</span>
              {editingField === 'value' ? (
                <div className="deal-metric-edit">
                  <input
                    type="number"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="deal-metric-input"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && saveEdit('value')}
                  />
                  <button onClick={() => saveEdit('value')} className="deal-metric-save">
                    <Check size={12} />
                  </button>
                </div>
              ) : (
                <button
                  className="deal-metric-value"
                  onClick={() => startEdit('value', deal.value)}
                >
                  {formatCurrency(deal.value)}
                  <Edit2 size={10} className="deal-edit-icon" />
                </button>
              )}
            </div>

            {/* Close Date */}
            <div className="deal-metric">
              <Calendar size={14} className="deal-metric-icon" />
              <span className="deal-metric-label text-xs text-muted">Close Date</span>
              {editingField === 'closeDate' ? (
                <div className="deal-metric-edit">
                  <input
                    type="date"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="deal-metric-input"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && saveEdit('closeDate')}
                  />
                  <button onClick={() => saveEdit('closeDate')} className="deal-metric-save">
                    <Check size={12} />
                  </button>
                </div>
              ) : (
                <button
                  className="deal-metric-value"
                  onClick={() => startEdit('closeDate', deal.closeDate)}
                >
                  {formatDate(deal.closeDate)}
                  <Edit2 size={10} className="deal-edit-icon" />
                </button>
              )}
            </div>

            {/* Probability */}
            <div className="deal-metric">
              <TrendingUp size={14} className="deal-metric-icon" />
              <span className="deal-metric-label text-xs text-muted">Probability</span>
              <div className="deal-probability">
                <div className="deal-probability-bar">
                  <div
                    className="deal-probability-fill"
                    style={{ width: `${deal.probability}%` }}
                  />
                </div>
                <span className="deal-probability-value text-sm font-medium">
                  {deal.probability}%
                </span>
              </div>
            </div>
          </div>

          {/* Contacts */}
          <div className="deal-contacts">
            <div className="deal-contacts-header">
              <Users size={14} className="deal-metric-icon" />
              <span className="deal-section-label text-xs text-muted">Key Contacts</span>
            </div>
            <div className="deal-contacts-list">
              {deal.contacts.map((contact, i) => (
                <div key={i} className={`deal-contact ${contact.isPrimary ? 'primary' : ''}`}>
                  <span className="deal-contact-name text-sm font-medium">{contact.name}</span>
                  <span className="deal-contact-role text-xs text-muted">{contact.role}</span>
                  {contact.isPrimary && (
                    <span className="deal-contact-badge">Primary</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Quick Notes */}
          {deal.notes && (
            <div className="deal-notes">
              <span className="deal-section-label text-xs text-muted">Notes</span>
              <p className="deal-notes-text text-sm">{deal.notes}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
