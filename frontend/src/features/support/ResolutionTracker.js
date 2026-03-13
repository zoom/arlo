import React, { useState } from 'react';
import { CheckCircle2, Circle, Clock, Target, Lightbulb, ThumbsUp, Tag, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import './ResolutionTracker.css';

/**
 * ResolutionTracker — Track call resolution workflow.
 *
 * Monitors progress through: Issue Identified → Solution Offered → Resolution Confirmed
 * Includes issue categorization and handle time awareness.
 */

const RESOLUTION_STEPS = [
  { id: 'issue', label: 'Issue Identified', icon: Target, description: 'Customer problem understood' },
  { id: 'solution', label: 'Solution Offered', icon: Lightbulb, description: 'Resolution proposed to customer' },
  { id: 'confirmed', label: 'Resolution Confirmed', icon: ThumbsUp, description: 'Customer accepts solution' },
];

const ISSUE_CATEGORIES = [
  { id: 'billing', label: 'Billing', color: '#8b5cf6' },
  { id: 'technical', label: 'Technical', color: '#2563eb' },
  { id: 'account', label: 'Account', color: '#0891b2' },
  { id: 'product', label: 'Product', color: '#16a34a' },
  { id: 'shipping', label: 'Shipping', color: '#f97316' },
  { id: 'other', label: 'Other', color: '#6b7280' },
];

// Demo data
const DEMO_STATE = {
  currentStep: 'solution', // issue, solution, or confirmed
  issueCategory: 'billing',
  issueSummary: 'Customer charged twice for monthly subscription',
  solutionOffered: 'Refund for duplicate charge + 1 month credit',
  callStartTime: Date.now() - 8 * 60 * 1000, // 8 minutes ago
  targetHandleTime: 10 * 60 * 1000, // 10 minute target
};

export default function ResolutionTracker({ segments }) {
  const [state, setState] = useState(DEMO_STATE);
  const [showDetails, setShowDetails] = useState(true);

  const currentStepIndex = RESOLUTION_STEPS.findIndex(s => s.id === state.currentStep);
  const elapsedTime = Math.floor((Date.now() - state.callStartTime) / 1000);
  const targetTime = state.targetHandleTime / 1000;
  const timePercent = Math.min((elapsedTime / targetTime) * 100, 100);
  const isOverTime = elapsedTime > targetTime;

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const advanceStep = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < RESOLUTION_STEPS.length) {
      setState(prev => ({ ...prev, currentStep: RESOLUTION_STEPS[nextIndex].id }));
    }
  };

  const setCategory = (categoryId) => {
    setState(prev => ({ ...prev, issueCategory: categoryId }));
  };

  const currentCategory = ISSUE_CATEGORIES.find(c => c.id === state.issueCategory);

  return (
    <Card className="resolution-tracker">
      <div className="resolution-header">
        <div className="resolution-title">
          <CheckCircle2 size={18} className="resolution-icon" />
          <h3 className="text-serif font-medium">Resolution Tracker</h3>
        </div>
        <div className={`resolution-timer ${isOverTime ? 'overtime' : ''}`}>
          <Clock size={14} />
          <span className="text-mono text-sm font-medium">{formatTime(elapsedTime)}</span>
          <span className="text-xs text-muted">/ {formatTime(targetTime)}</span>
        </div>
      </div>

      {/* Handle time progress bar */}
      <div className="resolution-time-bar">
        <div
          className={`resolution-time-fill ${isOverTime ? 'overtime' : ''}`}
          style={{ width: `${timePercent}%` }}
        />
      </div>

      {/* Resolution steps */}
      <div className="resolution-steps">
        {RESOLUTION_STEPS.map((step, index) => {
          const StepIcon = step.icon;
          const isCompleted = index < currentStepIndex;
          const isCurrent = index === currentStepIndex;
          const isPending = index > currentStepIndex;

          return (
            <div
              key={step.id}
              className={`resolution-step ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''} ${isPending ? 'pending' : ''}`}
            >
              <div className="resolution-step-indicator">
                {isCompleted ? (
                  <CheckCircle2 size={20} className="resolution-step-check" />
                ) : isCurrent ? (
                  <div className="resolution-step-current">
                    <StepIcon size={14} />
                  </div>
                ) : (
                  <Circle size={20} className="resolution-step-pending" />
                )}
                {index < RESOLUTION_STEPS.length - 1 && (
                  <div className={`resolution-step-line ${isCompleted ? 'completed' : ''}`} />
                )}
              </div>
              <div className="resolution-step-content">
                <span className="resolution-step-label text-sm font-medium">{step.label}</span>
                <span className="resolution-step-desc text-xs text-muted">{step.description}</span>
              </div>
              {isCurrent && currentStepIndex < RESOLUTION_STEPS.length - 1 && (
                <button className="resolution-advance-btn" onClick={advanceStep}>
                  Mark Complete
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Issue details */}
      <button
        className="resolution-details-toggle"
        onClick={() => setShowDetails(!showDetails)}
      >
        <Tag size={14} />
        <span className="text-sm">Issue Details</span>
        {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showDetails && (
        <div className="resolution-details">
          {/* Category selector */}
          <div className="resolution-category">
            <span className="resolution-label text-xs text-muted">Category</span>
            <div className="resolution-category-options">
              {ISSUE_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  className={`resolution-category-btn ${state.issueCategory === cat.id ? 'active' : ''}`}
                  style={{ '--cat-color': cat.color }}
                  onClick={() => setCategory(cat.id)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Issue summary */}
          <div className="resolution-summary">
            <span className="resolution-label text-xs text-muted">Issue</span>
            <p className="resolution-summary-text text-sm" style={{ '--cat-color': currentCategory?.color }}>
              {state.issueSummary}
            </p>
          </div>

          {/* Solution offered */}
          {currentStepIndex >= 1 && (
            <div className="resolution-solution">
              <span className="resolution-label text-xs text-muted">Solution Offered</span>
              <p className="resolution-solution-text text-sm">{state.solutionOffered}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
