import React, { useState } from 'react';
import { FileText, ChevronDown, ChevronUp, Sparkles, RefreshCw } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import './MeetingSummary.css';

/**
 * MeetingSummary — AI-generated meeting summary with key points.
 *
 * Shows a collapsible summary that updates as the meeting progresses.
 */

// Demo summary data
const DEMO_SUMMARY = {
  overview: "Discussion of Q2 product roadmap priorities, focusing on the new dashboard feature and API improvements. Team aligned on timeline and resource allocation.",
  keyPoints: [
    "Dashboard redesign approved for Q2 launch",
    "API rate limiting to be implemented by end of month",
    "New hire starting next Monday - Sarah to onboard",
    "Budget approved for additional cloud infrastructure",
  ],
  generatedAt: Date.now() - 2 * 60 * 1000, // 2 minutes ago
};

export default function MeetingSummary({ segments, meetingId }) {
  const [summary, setSummary] = useState(DEMO_SUMMARY);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  const regenerateSummary = () => {
    setIsGenerating(true);
    // Simulate AI generation
    setTimeout(() => {
      setSummary(prev => ({ ...prev, generatedAt: Date.now() }));
      setIsGenerating(false);
    }, 1500);
  };

  const timeSinceGenerated = Math.floor((Date.now() - summary.generatedAt) / 60000);

  return (
    <Card className="meeting-summary">
      <button
        className="meeting-summary-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="meeting-summary-title">
          <FileText size={18} className="meeting-summary-icon" />
          <h3 className="text-serif font-medium">Meeting Summary</h3>
          <span className="meeting-summary-badge">
            <Sparkles size={10} />
            AI
          </span>
        </div>
        <div className="meeting-summary-actions">
          <span className="meeting-summary-time text-xs text-muted">
            {timeSinceGenerated < 1 ? 'Just now' : `${timeSinceGenerated}m ago`}
          </span>
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      {isExpanded && (
        <div className="meeting-summary-content">
          <p className="meeting-summary-overview text-sm">
            {summary.overview}
          </p>

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

          <Button
            variant="ghost"
            size="sm"
            onClick={regenerateSummary}
            disabled={isGenerating}
            className="meeting-summary-refresh"
          >
            <RefreshCw size={14} className={isGenerating ? 'spin' : ''} />
            {isGenerating ? 'Generating...' : 'Refresh Summary'}
          </Button>
        </div>
      )}
    </Card>
  );
}
