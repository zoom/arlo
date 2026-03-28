import React, { useState } from 'react';
import { FileText, ChevronDown, ChevronUp, Sparkles, RefreshCw } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './MeetingSummary.css';

/**
 * MeetingSummary — AI-generated meeting summary with key points.
 *
 * Shows a collapsible summary that updates as the meeting progresses.
 */

// Demo summary data — Product team Q2 planning meeting
const DEMO_SUMMARY = {
  overview: "Product team Q2 planning session focused on mobile app launch, AI feature rollout, and infrastructure scalability. Team aligned on prioritizing mobile over web dashboard, with AI features slated for late Q2. Engineering flagged a potential delay risk around the payments integration.",
  keyPoints: [
    "Mobile app v1.0 approved as Q2 top priority — targeting April 15 beta",
    "AI-powered recommendations feature moved to late Q2 (dependency on mobile launch)",
    "Payments integration at risk — 3rd party API delays, backup plan discussed",
    "New senior engineer joining March 25 — will lead mobile backend work",
    "Design team to deliver mobile specs by end of week",
  ],
  generatedAt: Date.now() - 2 * 60 * 1000, // 2 minutes ago
};

const EMPTY_SUMMARY = {
  overview: '',
  keyPoints: [],
  decisions: [],
  nextSteps: [],
  generatedAt: Date.now(),
};

export default function MeetingSummary({ segments, meetingId, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('meeting-summary');
  const [summary, setSummary] = useState(showDemoData ? DEMO_SUMMARY : EMPTY_SUMMARY);
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
    <Card className={`meeting-summary ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="meeting-summary-header feature-collapse-header"
        onClick={() => toggleCollapsed('meeting-summary')}
        aria-expanded={!collapsed}
      >
        <div className="meeting-summary-title">
          <FileText size={18} className="meeting-summary-icon" />
          <h3 className="text-serif font-medium">Meeting Summary</h3>
          <span className="meeting-summary-badge">
            <Sparkles size={10} />
            AI
          </span>
        </div>
        <div className="feature-header-right">
          {!collapsed && (
            <span className="meeting-summary-time text-xs text-muted">
              {timeSinceGenerated < 1 ? 'Just now' : `${timeSinceGenerated}m ago`}
            </span>
          )}
          {collapsed ? <ChevronDown size={18} className="feature-chevron" /> : <ChevronUp size={18} className="feature-chevron" />}
        </div>
      </button>

      {!collapsed && (
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
