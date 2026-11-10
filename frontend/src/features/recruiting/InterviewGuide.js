import React, { useState, useCallback } from 'react';
import { ListChecks, ChevronRight, Check, RotateCcw, Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { getPreferredAiModel } from '../../utils/aiModel';
import './InterviewGuide.css';

/**
 * InterviewGuide — BrightHire-style live interview question prompts and coverage tracking.
 *
 * Features:
 * - Pre-defined question bank organized by competency
 * - Real-time tracking of which questions have been asked
 * - AI detection of covered topics from transcript
 * - Suggested follow-up questions
 */

const DEFAULT_QUESTION_BANK = [
  {
    competency: 'Technical Skills',
    questions: [
      { id: 't1', text: 'Walk me through a challenging technical problem you solved recently.', type: 'behavioral' },
      { id: 't2', text: 'How do you approach debugging a complex issue?', type: 'behavioral' },
      { id: 't3', text: 'Describe your experience with [relevant technology].', type: 'technical' },
    ],
  },
  {
    competency: 'Communication',
    questions: [
      { id: 'c1', text: 'Tell me about a time you had to explain a technical concept to a non-technical stakeholder.', type: 'behavioral' },
      { id: 'c2', text: 'Describe a situation where you had to deliver difficult feedback.', type: 'behavioral' },
    ],
  },
  {
    competency: 'Collaboration',
    questions: [
      { id: 'col1', text: 'Tell me about a time you disagreed with a teammate. How did you handle it?', type: 'behavioral' },
      { id: 'col2', text: 'Describe your ideal working relationship with your manager.', type: 'hypothetical' },
    ],
  },
  {
    competency: 'Ownership',
    questions: [
      { id: 'o1', text: 'Tell me about a project you initiated without being asked.', type: 'behavioral' },
      { id: 'o2', text: 'Describe a time when you had to make a decision with incomplete information.', type: 'behavioral' },
    ],
  },
  {
    competency: 'Culture Fit',
    questions: [
      { id: 'cf1', text: 'What type of work environment brings out your best work?', type: 'open' },
      { id: 'cf2', text: 'How do you handle receiving critical feedback?', type: 'behavioral' },
    ],
  },
];

export default function InterviewGuide({
  segments,
  questionBank = DEFAULT_QUESTION_BANK,
  onQuestionAsked,
  showDemoData = true,
}) {
  const [askedQuestions, setAskedQuestions] = useState(new Set());
  const [expandedCompetency, setExpandedCompetency] = useState(questionBank[0]?.competency || null);
  const [suggestedFollowUp, setSuggestedFollowUp] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // Calculate coverage per competency
  const coverage = questionBank.map(group => {
    const asked = group.questions.filter(q => askedQuestions.has(q.id)).length;
    return {
      competency: group.competency,
      asked,
      total: group.questions.length,
      percent: (asked / group.questions.length) * 100,
    };
  });

  const totalAsked = [...askedQuestions].length;
  const totalQuestions = questionBank.reduce((sum, g) => sum + g.questions.length, 0);
  const overallCoverage = totalQuestions > 0 ? (totalAsked / totalQuestions) * 100 : 0;

  const handleMarkAsked = useCallback((questionId) => {
    setAskedQuestions(prev => {
      const next = new Set(prev);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return next;
    });
    onQuestionAsked?.(questionId);
  }, [onQuestionAsked]);

  const handleReset = () => {
    setAskedQuestions(new Set());
  };

  // Generate AI follow-up based on recent transcript
  const generateFollowUp = useCallback(async () => {
    if (!segments || segments.length < 3) return;

    setIsGenerating(true);
    setSuggestedFollowUp(null);

    try {
      const recentText = segments
        .slice(-10)
        .map(s => `${s.speakerLabel}: ${s.text}`)
        .join('\n');

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: `Based on this interview conversation, suggest one thoughtful follow-up question that would help dig deeper into the candidate's experience. Keep it behavioral (starting with "Tell me about a time..." or "Can you walk me through...").

Recent conversation:
${recentText}

Respond with just the follow-up question, nothing else.`,
          model: getPreferredAiModel(),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setSuggestedFollowUp(data.response?.trim());
      }
    } catch (error) {
      console.error('Failed to generate follow-up:', error);
    } finally {
      setIsGenerating(false);
    }
  }, [segments]);

  return (
    <Card className="interview-guide">
      <div className="guide-header">
        <div className="guide-title">
          <ListChecks size={18} className="guide-icon" />
          <h3 className="text-serif font-medium">Interview Guide</h3>
        </div>
        <button
          className="guide-reset-btn"
          onClick={handleReset}
          title="Reset all"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Overall Coverage */}
      <div className="guide-coverage">
        <div className="guide-coverage-bar">
          <div
            className="guide-coverage-fill"
            style={{ width: `${overallCoverage}%` }}
          />
        </div>
        <span className="text-xs text-muted">
          {totalAsked}/{totalQuestions} questions covered ({Math.round(overallCoverage)}%)
        </span>
      </div>

      {/* Competency Sections */}
      <div className="guide-competencies">
        {questionBank.map(group => {
          const isExpanded = expandedCompetency === group.competency;
          const groupCoverage = coverage.find(c => c.competency === group.competency);

          return (
            <div key={group.competency} className="guide-competency">
              <button
                className="guide-competency-header"
                onClick={() => setExpandedCompetency(isExpanded ? null : group.competency)}
              >
                <div className="guide-competency-info">
                  <ChevronRight
                    size={16}
                    className={`guide-chevron ${isExpanded ? 'expanded' : ''}`}
                  />
                  <span className="text-sm font-medium">{group.competency}</span>
                </div>
                <div className="guide-competency-progress">
                  <div className="guide-mini-bar">
                    <div
                      className="guide-mini-fill"
                      style={{
                        width: `${groupCoverage?.percent || 0}%`,
                        background: groupCoverage?.percent === 100 ? '#10b981' : 'var(--accent)',
                      }}
                    />
                  </div>
                  <span className="text-xs text-muted">
                    {groupCoverage?.asked}/{groupCoverage?.total}
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="guide-questions">
                  {group.questions.map(question => {
                    const isAsked = askedQuestions.has(question.id);
                    return (
                      <button
                        key={question.id}
                        className={`guide-question ${isAsked ? 'asked' : ''}`}
                        onClick={() => handleMarkAsked(question.id)}
                      >
                        <div className={`guide-question-check ${isAsked ? 'checked' : ''}`}>
                          {isAsked && <Check size={12} />}
                        </div>
                        <span className="guide-question-text text-sm">
                          {question.text}
                        </span>
                        <span className="guide-question-type text-xs text-muted">
                          {question.type}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* AI Follow-up Suggestion */}
      <div className="guide-followup">
        <Button
          variant="outline"
          size="sm"
          onClick={generateFollowUp}
          disabled={isGenerating || segments?.length < 3}
        >
          <Sparkles size={14} />
          {isGenerating ? 'Generating...' : 'Suggest Follow-up'}
        </Button>

        {suggestedFollowUp && (
          <div className="guide-followup-suggestion">
            <span className="text-xs text-muted">Suggested follow-up:</span>
            <p className="text-sm">{suggestedFollowUp}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
