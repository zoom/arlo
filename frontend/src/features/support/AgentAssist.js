import React, { useState } from 'react';
import { Sparkles, BookOpen, Shield, ChevronRight, Check, AlertCircle, Copy, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import './AgentAssist.css';

/**
 * AgentAssist — Real-time knowledge and compliance assistance.
 *
 * Provides contextual knowledge base suggestions and tracks required
 * compliance disclosures during the call.
 */

// Demo knowledge suggestions
const DEMO_SUGGESTIONS = [
  {
    id: 1,
    title: 'Processing Refunds',
    category: 'Billing',
    snippet: 'Refunds are processed within 5-7 business days. For duplicate charges, offer a credit as goodwill...',
    relevance: 95,
    isNew: true,
  },
  {
    id: 2,
    title: 'Subscription Cancellation Policy',
    category: 'Account',
    snippet: 'Customers can cancel anytime. Pro-rated refunds available within first 30 days...',
    relevance: 82,
    isNew: false,
  },
  {
    id: 3,
    title: 'Escalation Procedures',
    category: 'Process',
    snippet: 'If customer requests manager, acknowledge their concern and offer to resolve first...',
    relevance: 68,
    isNew: false,
  },
];

// Demo compliance checklist
const DEMO_COMPLIANCE = [
  { id: 1, text: 'Verify customer identity', required: true, completed: true },
  { id: 2, text: 'State call may be recorded', required: true, completed: true },
  { id: 3, text: 'Confirm account changes verbally', required: true, completed: false },
  { id: 4, text: 'Offer confirmation email', required: false, completed: false },
  { id: 5, text: 'Provide case/reference number', required: true, completed: false },
];

// Demo quick responses
const QUICK_RESPONSES = [
  { id: 1, label: 'Empathy', text: "I completely understand how frustrating this must be. Let me help fix this right away." },
  { id: 2, label: 'Hold', text: "Would you mind holding briefly while I look into this for you?" },
  { id: 3, label: 'Clarify', text: "Just to make sure I understand correctly, you're saying that..." },
  { id: 4, label: 'Resolve', text: "I've gone ahead and processed that for you. Is there anything else I can help with?" },
];

export default function AgentAssist({ segments }) {
  const [suggestions] = useState(DEMO_SUGGESTIONS);
  const [compliance, setCompliance] = useState(DEMO_COMPLIANCE);
  const [activeTab, setActiveTab] = useState('suggestions');
  const [copiedId, setCopiedId] = useState(null);

  const toggleCompliance = (itemId) => {
    setCompliance(prev => prev.map(item =>
      item.id === itemId ? { ...item, completed: !item.completed } : item
    ));
  };

  const copyResponse = (id, text) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const completedRequired = compliance.filter(c => c.required && c.completed).length;
  const totalRequired = compliance.filter(c => c.required).length;
  const complianceComplete = completedRequired === totalRequired;

  return (
    <Card className="agent-assist">
      <div className="agent-assist-header">
        <div className="agent-assist-title">
          <Sparkles size={18} className="agent-assist-icon" />
          <h3 className="text-serif font-medium">Agent Assist</h3>
        </div>
        <div className="agent-assist-tabs">
          <button
            className={`agent-assist-tab ${activeTab === 'suggestions' ? 'active' : ''}`}
            onClick={() => setActiveTab('suggestions')}
          >
            <BookOpen size={14} />
            <span>Knowledge</span>
          </button>
          <button
            className={`agent-assist-tab ${activeTab === 'compliance' ? 'active' : ''} ${!complianceComplete ? 'has-pending' : ''}`}
            onClick={() => setActiveTab('compliance')}
          >
            <Shield size={14} />
            <span>Compliance</span>
            {!complianceComplete && (
              <span className="agent-assist-tab-badge">{totalRequired - completedRequired}</span>
            )}
          </button>
        </div>
      </div>

      {/* Knowledge suggestions tab */}
      {activeTab === 'suggestions' && (
        <div className="agent-assist-suggestions">
          <div className="agent-assist-section-header">
            <span className="text-xs text-muted">Suggested Articles</span>
          </div>
          <div className="agent-assist-suggestions-list">
            {suggestions.map(suggestion => (
              <button key={suggestion.id} className="agent-assist-suggestion">
                <div className="suggestion-header">
                  <span className="suggestion-title text-sm font-medium">{suggestion.title}</span>
                  {suggestion.isNew && <span className="suggestion-new">NEW</span>}
                </div>
                <span className="suggestion-category text-xs">{suggestion.category}</span>
                <p className="suggestion-snippet text-xs text-muted">{suggestion.snippet}</p>
                <div className="suggestion-footer">
                  <span className="suggestion-relevance text-xs">
                    {suggestion.relevance}% relevant
                  </span>
                  <ChevronRight size={14} className="suggestion-arrow" />
                </div>
              </button>
            ))}
          </div>

          {/* Quick responses */}
          <div className="agent-assist-quick">
            <span className="text-xs text-muted">Quick Responses</span>
            <div className="agent-assist-quick-list">
              {QUICK_RESPONSES.map(response => (
                <button
                  key={response.id}
                  className="quick-response-btn"
                  onClick={() => copyResponse(response.id, response.text)}
                  title={response.text}
                >
                  {copiedId === response.id ? (
                    <>
                      <Check size={12} />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      {response.label}
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Compliance tab */}
      {activeTab === 'compliance' && (
        <div className="agent-assist-compliance">
          <div className="compliance-progress">
            <div className="compliance-progress-bar">
              <div
                className="compliance-progress-fill"
                style={{ width: `${(completedRequired / totalRequired) * 100}%` }}
              />
            </div>
            <span className="compliance-progress-text text-xs">
              {completedRequired}/{totalRequired} required items
            </span>
          </div>

          <div className="compliance-list">
            {compliance.map(item => (
              <button
                key={item.id}
                className={`compliance-item ${item.completed ? 'completed' : ''} ${item.required ? 'required' : ''}`}
                onClick={() => toggleCompliance(item.id)}
              >
                <div className={`compliance-checkbox ${item.completed ? 'checked' : ''}`}>
                  {item.completed && <Check size={12} />}
                </div>
                <span className="compliance-text text-sm">{item.text}</span>
                {item.required && !item.completed && (
                  <AlertCircle size={14} className="compliance-required-icon" />
                )}
                {item.required && (
                  <span className="compliance-required-badge text-xs">Required</span>
                )}
              </button>
            ))}
          </div>

          {complianceComplete && (
            <div className="compliance-complete">
              <Check size={16} />
              <span className="text-sm font-medium">All required items completed</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
