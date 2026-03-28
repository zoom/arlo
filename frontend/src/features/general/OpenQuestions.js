import React, { useState } from 'react';
import { HelpCircle, Plus, Check, ExternalLink, X, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './OpenQuestions.css';

/**
 * OpenQuestions — Track unanswered questions from the meeting.
 *
 * Auto-detects questions that weren't answered and allows manual additions.
 */

// Demo questions — Product team Q2 planning meeting
const DEMO_QUESTIONS = [
  {
    id: 1,
    text: 'Do we have a backup vendor if Stripe continues to have sandbox issues?',
    askedBy: 'Priya Sharma',
    timestamp: '10:16:22 AM',
    seqNo: 48,
    answered: false,
    isAutoDetected: true,
  },
  {
    id: 2,
    text: 'What\'s the minimum iOS version we\'re supporting?',
    askedBy: 'Ava Martinez',
    timestamp: '10:20:15 AM',
    seqNo: 58,
    answered: true,
    isAutoDetected: true,
  },
  {
    id: 3,
    text: 'Who is handling the App Store submission process?',
    askedBy: 'Jordan Kim',
    timestamp: '10:28:33 AM',
    seqNo: 75,
    answered: false,
    isAutoDetected: true,
  },
  {
    id: 4,
    text: 'Should we do a soft launch in one market first or go global?',
    askedBy: 'Marcus Chen',
    timestamp: '10:35:18 AM',
    seqNo: 95,
    answered: false,
    isAutoDetected: true,
  },
];

export default function OpenQuestions({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('open-questions');
  const [questions, setQuestions] = useState(showDemoData ? DEMO_QUESTIONS : []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newQuestion, setNewQuestion] = useState('');
  const [filter, setFilter] = useState('open'); // 'open' | 'answered' | 'all'

  const addQuestion = () => {
    if (!newQuestion.trim()) return;
    const question = {
      id: Date.now(),
      text: newQuestion.trim(),
      askedBy: 'You',
      timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
      seqNo: null,
      answered: false,
      isAutoDetected: false,
    };
    setQuestions(prev => [...prev, question]);
    setNewQuestion('');
    setShowAddForm(false);
  };

  const toggleAnswered = (id) => {
    setQuestions(prev => prev.map(q =>
      q.id === id ? { ...q, answered: !q.answered } : q
    ));
  };

  const removeQuestion = (id) => {
    setQuestions(prev => prev.filter(q => q.id !== id));
  };

  const filteredQuestions = questions.filter(q => {
    if (filter === 'open') return !q.answered;
    if (filter === 'answered') return q.answered;
    return true;
  });

  const openCount = questions.filter(q => !q.answered).length;

  return (
    <Card className={`open-questions ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="open-questions-header feature-collapse-header"
        onClick={() => toggleCollapsed('open-questions')}
        aria-expanded={!collapsed}
      >
        <div className="open-questions-title">
          <HelpCircle size={18} className="open-questions-icon" />
          <h3 className="text-serif font-medium">Questions</h3>
          {openCount > 0 && (
            <span className="open-questions-badge">{openCount} open</span>
          )}
        </div>
        <div className="feature-header-right">
          {!collapsed && (
            <button
              className="open-questions-add-btn"
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

      {!collapsed && (
      <>
      {/* Filter tabs */}
      <div className="open-questions-filters">
        <button
          className={`open-questions-filter ${filter === 'open' ? 'active' : ''}`}
          onClick={() => setFilter('open')}
        >
          Open
        </button>
        <button
          className={`open-questions-filter ${filter === 'answered' ? 'active' : ''}`}
          onClick={() => setFilter('answered')}
        >
          Answered
        </button>
        <button
          className={`open-questions-filter ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All
        </button>
      </div>

      {showAddForm && (
        <div className="open-questions-add-form">
          <Input
            placeholder="Enter question..."
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addQuestion()}
            autoFocus
          />
          <div className="open-questions-add-actions">
            <button className="questions-add-btn" onClick={addQuestion}>Add</button>
            <button className="questions-cancel-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="open-questions-list">
        {filteredQuestions.length === 0 ? (
          <p className="open-questions-empty text-sm text-muted">
            {filter === 'open' ? 'No open questions' : filter === 'answered' ? 'No answered questions' : 'No questions captured'}
          </p>
        ) : (
          filteredQuestions.map(question => (
            <div key={question.id} className={`question-item ${question.answered ? 'answered' : ''}`}>
              <button
                className={`question-checkbox ${question.answered ? 'checked' : ''}`}
                onClick={() => toggleAnswered(question.id)}
              >
                {question.answered && <Check size={12} />}
              </button>
              <div className="question-content">
                <p className={`question-text text-sm ${question.answered ? 'answered' : ''}`}>
                  {question.text}
                </p>
                <div className="question-meta">
                  <span className="question-by text-xs text-muted">
                    {question.askedBy}
                  </span>
                  <span className="question-time text-mono text-xs text-muted">
                    {question.timestamp}
                  </span>
                  {question.isAutoDetected && (
                    <span className="question-auto text-xs">Auto</span>
                  )}
                </div>
              </div>
              <div className="question-actions">
                {question.seqNo && (
                  <button
                    className="question-jump"
                    onClick={() => onJumpToSegment?.(question.seqNo)}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                <button
                  className="question-remove"
                  onClick={() => removeQuestion(question.id)}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      </>
      )}
    </Card>
  );
}
