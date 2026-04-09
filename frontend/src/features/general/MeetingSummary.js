import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, ChevronDown, ChevronUp, Sparkles, RefreshCw } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './MeetingSummary.css';

/**
 * MeetingSummary — AI-generated meeting summary with key points.
 *
 * Analyzes transcript segments to generate a live summary that updates
 * as the meeting progresses. Uses AI to extract overview and key points.
 */

const EMPTY_SUMMARY = {
  overview: '',
  keyPoints: [],
  decisions: [],
  nextSteps: [],
  generatedAt: null,
};

// Generate summary using AI
async function generateSummaryAI(transcript, title) {
  try {
    const response = await fetch('/api/ai/summary-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ transcript, title }),
    });

    if (!response.ok) {
      console.error('Summary API error:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Summary generation failed:', error);
    return null;
  }
}

// Build transcript text from segments
function buildTranscriptText(segments) {
  if (!segments || segments.length === 0) return '';

  return segments
    .map(seg => {
      const speaker = seg.speaker?.displayName || seg.speaker?.label || 'Speaker';
      return `[${speaker}]: ${seg.text}`;
    })
    .join('\n');
}

export default function MeetingSummary({ segments, meetingId, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('meeting-summary');
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const lastGeneratedSegmentCount = useRef(0);
  const autoGenerateTimer = useRef(null);

  // Auto-generate summary when enough new content arrives
  const scheduleAutoGenerate = useCallback(() => {
    // Clear any pending timer
    if (autoGenerateTimer.current) {
      clearTimeout(autoGenerateTimer.current);
    }

    // Only auto-generate if we have significant new content
    const segmentCount = segments?.length || 0;
    const newSegments = segmentCount - lastGeneratedSegmentCount.current;

    // Auto-generate every 20 new segments (roughly 2-3 minutes of conversation)
    if (newSegments >= 20 && !isGenerating) {
      autoGenerateTimer.current = setTimeout(() => {
        generateSummary();
      }, 2000); // Small delay to batch rapid segments
    }
  }, [segments, isGenerating]);

  // Watch for new segments
  useEffect(() => {
    scheduleAutoGenerate();

    return () => {
      if (autoGenerateTimer.current) {
        clearTimeout(autoGenerateTimer.current);
      }
    };
  }, [segments, scheduleAutoGenerate]);

  const generateSummary = async () => {
    if (!segments || segments.length === 0) {
      setError('No transcript available yet');
      return;
    }

    const transcript = buildTranscriptText(segments);
    if (transcript.length < 50) {
      setError('Not enough transcript to summarize');
      return;
    }

    setIsGenerating(true);
    setError(null);

    const result = await generateSummaryAI(transcript, 'Meeting');

    if (result && result.summary) {
      setSummary({
        ...result.summary,
        generatedAt: result.generatedAt || Date.now(),
      });
      lastGeneratedSegmentCount.current = segments.length;
    } else {
      setError('Failed to generate summary');
    }

    setIsGenerating(false);
  };

  const timeSinceGenerated = summary.generatedAt
    ? Math.floor((Date.now() - summary.generatedAt) / 60000)
    : null;

  const hasContent = summary.overview || (summary.keyPoints && summary.keyPoints.length > 0);

  return (
    <Card className={`meeting-summary ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="meeting-summary-header feature-collapse-header"
        onClick={() => toggleCollapsed('meeting-summary')}
        aria-expanded={!collapsed}
      >
        <div className="meeting-summary-title">
          <FileText size={18} className="meeting-summary-icon" />
          <h3 className="text-serif font-medium">Meeting Summary</h3>
          {isGenerating ? (
            <span className="meeting-summary-generating-badge">
              <Sparkles size={10} />
              Generating...
            </span>
          ) : hasContent ? (
            <span className="meeting-summary-badge">
              <Sparkles size={10} />
              AI
            </span>
          ) : (
            <span className="meeting-summary-waiting-badge">Waiting...</span>
          )}
        </div>
        <div className="feature-header-right">
          {!collapsed && timeSinceGenerated !== null && (
            <span className="meeting-summary-time text-xs text-muted">
              {timeSinceGenerated < 1 ? 'Just now' : `${timeSinceGenerated}m ago`}
            </span>
          )}
          {collapsed ? <ChevronDown size={18} className="feature-chevron" /> : <ChevronUp size={18} className="feature-chevron" />}
        </div>
      </button>

      {!collapsed && (
        <div className="meeting-summary-content">
          {error && (
            <p className="meeting-summary-error text-sm">{error}</p>
          )}

          {!hasContent && !error && !isGenerating && (
            <p className="meeting-summary-empty text-sm text-muted">
              Click "Generate Summary" or wait for AI to summarize the conversation...
            </p>
          )}

          {summary.overview && (
            <p className="meeting-summary-overview text-sm">
              {summary.overview}
            </p>
          )}

          {summary.keyPoints && summary.keyPoints.length > 0 && (
            <div className="meeting-summary-points">
              <span className="meeting-summary-points-label text-xs text-muted">Key Points</span>
              <ul className="meeting-summary-points-list">
                {summary.keyPoints.map((point, i) => (
                  <li key={i} className="meeting-summary-point text-sm">
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.decisions && summary.decisions.length > 0 && (
            <div className="meeting-summary-points">
              <span className="meeting-summary-points-label text-xs text-muted">Decisions</span>
              <ul className="meeting-summary-points-list">
                {summary.decisions.map((decision, i) => (
                  <li key={i} className="meeting-summary-point text-sm">
                    {decision}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.nextSteps && summary.nextSteps.length > 0 && (
            <div className="meeting-summary-points">
              <span className="meeting-summary-points-label text-xs text-muted">Next Steps</span>
              <ul className="meeting-summary-points-list">
                {summary.nextSteps.map((step, i) => (
                  <li key={i} className="meeting-summary-point text-sm">
                    {step}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={generateSummary}
            disabled={isGenerating || !segments || segments.length === 0}
            className="meeting-summary-refresh"
          >
            <RefreshCw size={14} className={isGenerating ? 'spin' : ''} />
            {isGenerating ? 'Generating...' : 'Generate Summary'}
          </Button>
        </div>
      )}
    </Card>
  );
}
