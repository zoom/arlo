import React, { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Check, X, Minus, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { getPreferredAiModel } from '../../utils/aiModel';
import './InterviewScorecard.css';

/**
 * InterviewScorecard — BrightHire-style structured evaluation with competency rubrics.
 *
 * Features:
 * - Pre-defined competencies based on job requirements
 * - Rating scale with behavioral anchors
 * - AI-assisted scoring suggestions based on transcript
 * - Notes per competency
 * - Overall recommendation
 */

const DEFAULT_COMPETENCIES = [
  {
    id: 'technical',
    name: 'Technical Skills',
    description: 'Demonstrates relevant technical knowledge and problem-solving ability',
    weight: 25,
  },
  {
    id: 'communication',
    name: 'Communication',
    description: 'Articulates ideas clearly, listens actively, and adapts to audience',
    weight: 20,
  },
  {
    id: 'collaboration',
    name: 'Collaboration',
    description: 'Works effectively with others, handles conflict constructively',
    weight: 20,
  },
  {
    id: 'ownership',
    name: 'Ownership & Initiative',
    description: 'Takes responsibility, drives results, and shows proactive thinking',
    weight: 20,
  },
  {
    id: 'culture',
    name: 'Culture Fit',
    description: 'Aligns with company values and demonstrates growth mindset',
    weight: 15,
  },
];

const RATING_OPTIONS = [
  { value: 4, label: 'Strong Yes', icon: Check, color: '#10b981', description: 'Exceeds expectations' },
  { value: 3, label: 'Yes', icon: Check, color: '#22c55e', description: 'Meets expectations' },
  { value: 2, label: 'Mixed', icon: Minus, color: '#f59e0b', description: 'Some concerns' },
  { value: 1, label: 'No', icon: X, color: '#ef4444', description: 'Does not meet bar' },
];

const RECOMMENDATION_OPTIONS = [
  { value: 'strong-hire', label: 'Strong Hire', color: '#10b981' },
  { value: 'hire', label: 'Hire', color: '#22c55e' },
  { value: 'lean-hire', label: 'Lean Hire', color: '#84cc16' },
  { value: 'lean-no-hire', label: 'Lean No Hire', color: '#f59e0b' },
  { value: 'no-hire', label: 'No Hire', color: '#ef4444' },
];

export default function InterviewScorecard({
  segments,
  meetingId,
  competencies = DEFAULT_COMPETENCIES,
  onSave,
  showDemoData = true,
}) {
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});
  const [expandedCompetency, setExpandedCompetency] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [overallNotes, setOverallNotes] = useState('');
  const [aiSuggesting, setAiSuggesting] = useState(null);
  const [aiSuggestions, setAiSuggestions] = useState({});
  const [isDirty, setIsDirty] = useState(false);

  // Calculate weighted score
  const weightedScore = competencies.reduce((total, comp) => {
    const score = scores[comp.id];
    if (score === undefined) return total;
    return total + (score / 4) * comp.weight;
  }, 0);

  const maxPossibleScore = competencies.reduce((total, comp) => {
    return scores[comp.id] !== undefined ? total + comp.weight : total;
  }, 0);

  const percentComplete = (Object.keys(scores).length / competencies.length) * 100;
  const normalizedScore = maxPossibleScore > 0 ? (weightedScore / maxPossibleScore) * 100 : 0;

  // Request AI suggestion for a competency
  const requestAiSuggestion = useCallback(async (competencyId) => {
    if (!segments || segments.length < 3) return;

    const competency = competencies.find(c => c.id === competencyId);
    if (!competency) return;

    setAiSuggesting(competencyId);

    try {
      const transcriptText = segments
        .slice(-20)
        .map(s => `${s.speakerLabel}: ${s.text}`)
        .join('\n');

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: `Based on this interview transcript, evaluate the candidate on "${competency.name}" (${competency.description}).

Provide a brief assessment (2-3 sentences) with specific examples from the conversation. Then suggest a rating: Strong Yes (4), Yes (3), Mixed (2), or No (1).

Transcript:
${transcriptText}

Format your response as:
ASSESSMENT: [your assessment]
SUGGESTED_RATING: [1-4]`,
          model: getPreferredAiModel(),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.response || '';

        // Parse AI response
        const assessmentMatch = text.match(/ASSESSMENT:\s*(.+?)(?=SUGGESTED_RATING:|$)/s);
        const ratingMatch = text.match(/SUGGESTED_RATING:\s*(\d)/);

        setAiSuggestions(prev => ({
          ...prev,
          [competencyId]: {
            assessment: assessmentMatch ? assessmentMatch[1].trim() : text,
            suggestedRating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
          },
        }));
      }
    } catch (error) {
      console.error('AI suggestion failed:', error);
    } finally {
      setAiSuggesting(null);
    }
  }, [segments, competencies]);

  const handleScoreChange = (competencyId, value) => {
    setScores(prev => ({ ...prev, [competencyId]: value }));
    setIsDirty(true);
  };

  const handleNotesChange = (competencyId, value) => {
    setNotes(prev => ({ ...prev, [competencyId]: value }));
    setIsDirty(true);
  };

  const handleSave = () => {
    onSave?.({
      scores,
      notes,
      recommendation,
      overallNotes,
      weightedScore: normalizedScore,
      timestamp: Date.now(),
    });
    setIsDirty(false);
  };

  return (
    <Card className="interview-scorecard">
      <div className="scorecard-header">
        <div className="scorecard-title">
          <ClipboardList size={18} className="scorecard-icon" />
          <h3 className="text-serif font-medium">Interview Scorecard</h3>
        </div>
        <div className="scorecard-progress">
          <div className="scorecard-progress-bar">
            <div
              className="scorecard-progress-fill"
              style={{ width: `${percentComplete}%` }}
            />
          </div>
          <span className="text-xs text-muted">
            {Object.keys(scores).length}/{competencies.length} rated
          </span>
        </div>
      </div>

      {/* Overall Score Display */}
      {percentComplete > 0 && (
        <div className="scorecard-overall">
          <div className="scorecard-score-display">
            <span className="scorecard-score-value">{Math.round(normalizedScore)}</span>
            <span className="scorecard-score-label text-xs text-muted">/100</span>
          </div>
          <div className="scorecard-score-bar">
            <div
              className="scorecard-score-fill"
              style={{
                width: `${normalizedScore}%`,
                background: normalizedScore >= 75 ? '#10b981' :
                           normalizedScore >= 50 ? '#f59e0b' : '#ef4444'
              }}
            />
          </div>
        </div>
      )}

      {/* Competency List */}
      <div className="scorecard-competencies">
        {competencies.map(comp => {
          const score = scores[comp.id];
          const isExpanded = expandedCompetency === comp.id;
          const suggestion = aiSuggestions[comp.id];
          const isSuggesting = aiSuggesting === comp.id;

          return (
            <div
              key={comp.id}
              className={`scorecard-competency ${isExpanded ? 'expanded' : ''}`}
            >
              <button
                className="scorecard-competency-header"
                onClick={() => setExpandedCompetency(isExpanded ? null : comp.id)}
              >
                <div className="scorecard-competency-info">
                  <span className="scorecard-competency-name text-sm font-medium">
                    {comp.name}
                  </span>
                  <span className="scorecard-competency-weight text-xs text-muted">
                    {comp.weight}%
                  </span>
                </div>
                <div className="scorecard-competency-actions">
                  {score !== undefined && (
                    <span
                      className="scorecard-rating-badge"
                      style={{ background: RATING_OPTIONS.find(r => r.value === score)?.color }}
                    >
                      {RATING_OPTIONS.find(r => r.value === score)?.label}
                    </span>
                  )}
                  {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>

              {isExpanded && (
                <div className="scorecard-competency-content">
                  <p className="text-xs text-muted scorecard-competency-desc">
                    {comp.description}
                  </p>

                  {/* Rating buttons */}
                  <div className="scorecard-ratings">
                    {RATING_OPTIONS.map(option => {
                      const Icon = option.icon;
                      const isSelected = score === option.value;
                      return (
                        <button
                          key={option.value}
                          className={`scorecard-rating-btn ${isSelected ? 'selected' : ''}`}
                          style={{ '--rating-color': option.color }}
                          onClick={() => handleScoreChange(comp.id, option.value)}
                          title={option.description}
                        >
                          <Icon size={14} />
                          <span className="text-xs">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* AI Suggestion */}
                  <div className="scorecard-ai-section">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => requestAiSuggestion(comp.id)}
                      disabled={isSuggesting || segments?.length < 3}
                    >
                      <Sparkles size={14} />
                      {isSuggesting ? 'Analyzing...' : 'AI Suggest'}
                    </Button>

                    {suggestion && (
                      <div className="scorecard-ai-suggestion">
                        <p className="text-xs">{suggestion.assessment}</p>
                        {suggestion.suggestedRating && (
                          <button
                            className="scorecard-apply-suggestion text-xs"
                            onClick={() => handleScoreChange(comp.id, suggestion.suggestedRating)}
                          >
                            Apply suggested rating: {RATING_OPTIONS.find(r => r.value === suggestion.suggestedRating)?.label}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Notes */}
                  <textarea
                    className="scorecard-notes"
                    placeholder="Add notes with specific examples..."
                    value={notes[comp.id] || ''}
                    onChange={(e) => handleNotesChange(comp.id, e.target.value)}
                    rows={2}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Overall Recommendation */}
      <div className="scorecard-recommendation">
        <span className="text-sm font-medium">Overall Recommendation</span>
        <div className="scorecard-recommendation-options">
          {RECOMMENDATION_OPTIONS.map(option => (
            <button
              key={option.value}
              className={`scorecard-rec-btn ${recommendation === option.value ? 'selected' : ''}`}
              style={{ '--rec-color': option.color }}
              onClick={() => {
                setRecommendation(option.value);
                setIsDirty(true);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <textarea
          className="scorecard-overall-notes"
          placeholder="Summary and final thoughts..."
          value={overallNotes}
          onChange={(e) => {
            setOverallNotes(e.target.value);
            setIsDirty(true);
          }}
          rows={3}
        />
      </div>

      {/* Save Button */}
      {isDirty && (
        <div className="scorecard-save">
          <Button onClick={handleSave}>
            <Check size={16} />
            Save Scorecard
          </Button>
        </div>
      )}
    </Card>
  );
}
