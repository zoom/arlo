import React, { useState, useEffect, useMemo } from 'react';
import { Mic2, Clock, MessageSquare, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import Card from '../../components/ui/Card';
import './InterviewerCoaching.css';

/**
 * InterviewerCoaching — BrightHire-style interviewer effectiveness metrics.
 *
 * Real-time coaching feedback for interviewers including:
 * - Talk-to-listen ratio (target: 30-40% interviewer talk time)
 * - Question quality and type detection
 * - Bias alerts for potentially problematic questions
 * - Pacing and time management
 */

// Question type patterns for detection
const QUESTION_PATTERNS = {
  behavioral: {
    patterns: [
      /tell me about a time/i,
      /describe a situation/i,
      /give me an example/i,
      /walk me through/i,
      /how did you handle/i,
      /what was your approach/i,
    ],
    label: 'Behavioral',
    good: true,
  },
  technical: {
    patterns: [
      /how would you implement/i,
      /what's the difference between/i,
      /explain how .* works/i,
      /design a system/i,
      /what algorithm/i,
      /time complexity/i,
    ],
    label: 'Technical',
    good: true,
  },
  hypothetical: {
    patterns: [
      /what would you do if/i,
      /how would you handle/i,
      /imagine a scenario/i,
      /suppose you had to/i,
    ],
    label: 'Hypothetical',
    good: true,
  },
  leading: {
    patterns: [
      /don't you think/i,
      /wouldn't you agree/i,
      /surely you/i,
      /you probably/i,
      /i assume you/i,
    ],
    label: 'Leading',
    good: false,
  },
  illegal: {
    patterns: [
      /how old are you/i,
      /are you married/i,
      /do you have kids/i,
      /children/i,
      /pregnant/i,
      /religion/i,
      /religious/i,
      /political/i,
      /nationality/i,
      /where are you from originally/i,
      /disability/i,
      /health condition/i,
    ],
    label: 'Potentially Illegal',
    good: false,
    alert: true,
  },
};

// Filler words to detect
const FILLER_WORDS = ['um', 'uh', 'like', 'you know', 'basically', 'actually', 'literally', 'sort of', 'kind of'];

function detectQuestionTypes(text) {
  const types = [];
  for (const [type, config] of Object.entries(QUESTION_PATTERNS)) {
    if (config.patterns.some(pattern => pattern.test(text))) {
      types.push({ type, ...config });
    }
  }
  return types;
}

function countFillerWords(text) {
  const lowerText = text.toLowerCase();
  return FILLER_WORDS.reduce((count, filler) => {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    return count + (lowerText.match(regex)?.length || 0);
  }, 0);
}

export default function InterviewerCoaching({
  segments,
  interviewerName,
  showDemoData = true,
}) {
  const [alerts, setAlerts] = useState([]);

  // Calculate metrics from segments
  const metrics = useMemo(() => {
    if (!segments || segments.length === 0) {
      return {
        interviewerTalkRatio: 0,
        candidateTalkRatio: 0,
        totalDuration: 0,
        questionCount: 0,
        questionTypes: {},
        fillerCount: 0,
        avgResponseLength: 0,
      };
    }

    // Separate interviewer and candidate segments
    // Assume interviewer segments are those from the meeting host or match interviewerName
    const interviewerSegments = segments.filter(s =>
      s.speakerLabel?.toLowerCase().includes('host') ||
      s.speakerLabel?.toLowerCase() === interviewerName?.toLowerCase()
    );
    const candidateSegments = segments.filter(s =>
      !s.speakerLabel?.toLowerCase().includes('host') &&
      s.speakerLabel?.toLowerCase() !== interviewerName?.toLowerCase()
    );

    // Calculate talk time (approximate by word count)
    const interviewerWords = interviewerSegments.reduce((sum, s) => sum + (s.text?.split(/\s+/).length || 0), 0);
    const candidateWords = candidateSegments.reduce((sum, s) => sum + (s.text?.split(/\s+/).length || 0), 0);
    const totalWords = interviewerWords + candidateWords;

    // Detect questions in interviewer segments
    let questionCount = 0;
    const questionTypes = {};
    let fillerCount = 0;

    interviewerSegments.forEach(s => {
      const text = s.text || '';

      // Count questions (ends with ?)
      const questions = text.match(/[^.!?]*\?/g) || [];
      questionCount += questions.length;

      // Detect question types
      questions.forEach(q => {
        const types = detectQuestionTypes(q);
        types.forEach(t => {
          questionTypes[t.type] = (questionTypes[t.type] || 0) + 1;
        });
      });

      // Count filler words
      fillerCount += countFillerWords(text);
    });

    // Calculate average candidate response length
    const avgResponseLength = candidateSegments.length > 0
      ? candidateWords / candidateSegments.length
      : 0;

    return {
      interviewerTalkRatio: totalWords > 0 ? (interviewerWords / totalWords) * 100 : 0,
      candidateTalkRatio: totalWords > 0 ? (candidateWords / totalWords) * 100 : 0,
      totalDuration: segments.length > 0
        ? (segments[segments.length - 1].tStartMs - segments[0].tStartMs) / 1000 / 60
        : 0,
      questionCount,
      questionTypes,
      fillerCount,
      avgResponseLength: Math.round(avgResponseLength),
    };
  }, [segments, interviewerName]);

  // Check for alerts when segments change
  useEffect(() => {
    if (!segments || segments.length === 0) return;

    const newAlerts = [];

    // Check recent interviewer segments for problematic patterns
    const recentInterviewerSegments = segments
      .filter(s => s.speakerLabel?.toLowerCase().includes('host'))
      .slice(-5);

    recentInterviewerSegments.forEach(s => {
      const questions = (s.text?.match(/[^.!?]*\?/g) || []);
      questions.forEach(q => {
        const types = detectQuestionTypes(q);
        types.forEach(t => {
          if (t.alert) {
            newAlerts.push({
              type: t.type,
              label: t.label,
              text: q.trim(),
              timestamp: s.tStartMs,
            });
          }
        });
      });
    });

    if (newAlerts.length > 0) {
      setAlerts(prev => [...prev.slice(-4), ...newAlerts]);
    }
  }, [segments]);

  // Determine talk ratio status
  const talkRatioStatus = useMemo(() => {
    const ratio = metrics.interviewerTalkRatio;
    if (ratio < 25) return { status: 'low', label: 'Too quiet', color: '#f59e0b' };
    if (ratio <= 40) return { status: 'good', label: 'Good balance', color: '#10b981' };
    if (ratio <= 50) return { status: 'high', label: 'Talking a bit much', color: '#f59e0b' };
    return { status: 'very-high', label: 'Let candidate speak more', color: '#ef4444' };
  }, [metrics.interviewerTalkRatio]);

  return (
    <Card className="interviewer-coaching">
      <div className="coaching-header">
        <div className="coaching-title">
          <Mic2 size={18} className="coaching-icon" />
          <h3 className="text-serif font-medium">Interviewer Coaching</h3>
        </div>
        <span className="feature-live-badge">Live</span>
      </div>

      {/* Talk Ratio Meter */}
      <div className="coaching-metric">
        <div className="metric-header">
          <span className="text-sm font-medium">Talk-to-Listen Ratio</span>
          <span
            className="metric-status text-xs"
            style={{ color: talkRatioStatus.color }}
          >
            {talkRatioStatus.label}
          </span>
        </div>
        <div className="talk-ratio-bar">
          <div
            className="talk-ratio-interviewer"
            style={{
              width: `${metrics.interviewerTalkRatio}%`,
              background: talkRatioStatus.color,
            }}
          />
          <div
            className="talk-ratio-target"
            style={{ left: '30%', width: '10%' }}
            title="Target: 30-40%"
          />
        </div>
        <div className="talk-ratio-labels">
          <span className="text-xs text-muted">
            You: {Math.round(metrics.interviewerTalkRatio)}%
          </span>
          <span className="text-xs text-muted">
            Candidate: {Math.round(metrics.candidateTalkRatio)}%
          </span>
        </div>
      </div>

      {/* Question Stats */}
      <div className="coaching-stats">
        <div className="coaching-stat">
          <MessageSquare size={16} />
          <div className="stat-content">
            <span className="stat-value">{metrics.questionCount}</span>
            <span className="stat-label text-xs text-muted">Questions Asked</span>
          </div>
        </div>

        <div className="coaching-stat">
          <Clock size={16} />
          <div className="stat-content">
            <span className="stat-value">{metrics.avgResponseLength}</span>
            <span className="stat-label text-xs text-muted">Avg Response (words)</span>
          </div>
        </div>

        <div className="coaching-stat">
          <span className="stat-icon text-muted">um</span>
          <div className="stat-content">
            <span className="stat-value">{metrics.fillerCount}</span>
            <span className="stat-label text-xs text-muted">Filler Words</span>
          </div>
        </div>
      </div>

      {/* Question Type Breakdown */}
      {Object.keys(metrics.questionTypes).length > 0 && (
        <div className="coaching-question-types">
          <span className="text-xs text-muted">Question Types</span>
          <div className="question-type-tags">
            {Object.entries(metrics.questionTypes).map(([type, count]) => {
              const config = QUESTION_PATTERNS[type];
              return (
                <span
                  key={type}
                  className={`question-type-tag ${config?.good ? 'good' : 'bad'}`}
                >
                  {config?.label || type}: {count}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="coaching-alerts">
          {alerts.slice(-2).map((alert, i) => (
            <div key={i} className="coaching-alert">
              <AlertTriangle size={14} className="alert-icon" />
              <div className="alert-content">
                <span className="alert-label text-xs font-medium">{alert.label}</span>
                <span className="alert-text text-xs text-muted">"{alert.text}"</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tips */}
      <div className="coaching-tips">
        <span className="text-xs text-muted">Tips</span>
        <ul className="coaching-tips-list">
          <li className="text-xs">Aim for 30-40% talk time — let candidates shine</li>
          <li className="text-xs">Use behavioral questions ("Tell me about a time...")</li>
          <li className="text-xs">Pause 3 seconds after candidate answers before following up</li>
        </ul>
      </div>
    </Card>
  );
}
