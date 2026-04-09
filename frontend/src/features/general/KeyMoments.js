import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Zap, ExternalLink, Star, StarOff, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './KeyMoments.css';

/**
 * KeyMoments — AI-powered detection of important moments in the meeting.
 *
 * Analyzes transcript segments in real-time to identify significant statements,
 * announcements, agreements, concerns, insights, and milestones.
 */

const MOMENT_TYPES = {
  announcement: { label: 'Announcement', color: '#8b5cf6' },
  agreement: { label: 'Agreement', color: '#22c55e' },
  concern: { label: 'Concern', color: '#f97316' },
  insight: { label: 'Insight', color: '#2563eb' },
  milestone: { label: 'Milestone', color: '#ec4899' },
};

// Analyze segment for key moment using AI
async function analyzeKeyMomentAI(text) {
  try {
    const response = await fetch('/api/ai/key-moment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error('Key moment API error:', response.status);
      return null;
    }

    const result = await response.json();
    if (result.skip) return null;
    return result;
  } catch (error) {
    console.error('Key moment analysis failed:', error);
    return null;
  }
}

export default function KeyMoments({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('key-moments');
  const [moments, setMoments] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const lastProcessedSeqNo = useRef(-1);
  const analysisQueue = useRef([]);
  const isProcessingQueue = useRef(false);
  const momentIdCounter = useRef(1);

  // Process queued segments with AI (debounced)
  const processQueue = useCallback(async () => {
    if (isProcessingQueue.current || analysisQueue.current.length === 0) return;

    isProcessingQueue.current = true;
    setIsAnalyzing(true);

    // Process segments one at a time
    while (analysisQueue.current.length > 0) {
      const segment = analysisQueue.current.shift();

      if (segment && segment.text && segment.text.length >= 10) {
        const result = await analyzeKeyMomentAI(segment.text);

        if (result && result.type && MOMENT_TYPES[result.type]) {
          // Format timestamp
          const ts = segment.tStartMs || segment.timestamp;
          let timestamp = '';
          if (typeof ts === 'number' && ts > 0) {
            timestamp = new Date(ts).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
            });
          }

          const newMoment = {
            id: momentIdCounter.current++,
            type: result.type,
            text: `"${result.text}"`,
            speaker: segment.speaker?.displayName || segment.speaker?.label || 'Speaker',
            timestamp,
            seqNo: segment.seqNo,
            starred: false,
            confidence: result.confidence,
          };

          setMoments(prev => [...prev, newMoment]);
        }
      }

      // Small delay between processing to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    setIsAnalyzing(false);
    isProcessingQueue.current = false;
  }, []);

  // Queue segment for analysis
  const queueSegment = useCallback((segment) => {
    if (!segment.text || segment.text.trim().length < 10) return;

    analysisQueue.current.push(segment);

    // Debounce: wait before processing
    setTimeout(() => {
      processQueue();
    }, 1000);
  }, [processQueue]);

  // Watch for new transcript segments
  useEffect(() => {
    if (!segments || segments.length === 0) return;

    // Process only new segments
    const newSegments = segments.filter(s => {
      const seqNo = Number(s.seqNo);
      return !isNaN(seqNo) && seqNo > lastProcessedSeqNo.current;
    });

    if (newSegments.length > 0) {
      // Queue each new segment for analysis
      newSegments.forEach(segment => {
        queueSegment(segment);
      });
      // Update last processed
      const maxSeqNo = Math.max(...newSegments.map(s => Number(s.seqNo)));
      lastProcessedSeqNo.current = maxSeqNo;
    }
  }, [segments, queueSegment]);

  const toggleStar = (momentId) => {
    setMoments(prev => prev.map(m =>
      m.id === momentId ? { ...m, starred: !m.starred } : m
    ));
  };

  const starredCount = moments.filter(m => m.starred).length;

  return (
    <Card className={`key-moments ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="key-moments-header feature-collapse-header"
        onClick={() => toggleCollapsed('key-moments')}
        aria-expanded={!collapsed}
      >
        <div className="key-moments-title">
          <Zap size={18} className="key-moments-icon" />
          <h3 className="text-serif font-medium">Key Moments</h3>
          {isAnalyzing ? (
            <span className="key-moments-analyzing-badge">
              <Sparkles size={10} />
              Analyzing...
            </span>
          ) : moments.length > 0 ? (
            <span className="feature-live-badge">AI</span>
          ) : (
            <span className="key-moments-waiting-badge">Listening...</span>
          )}
          {moments.length > 0 && (
            <span className="key-moments-count">{moments.length}</span>
          )}
        </div>
        <div className="feature-header-right">
          {starredCount > 0 && !collapsed && (
            <span className="key-moments-starred text-xs">
              <Star size={12} />
              {starredCount} starred
            </span>
          )}
          {collapsed ? (
            <ChevronDown size={16} className="feature-chevron" />
          ) : (
            <ChevronUp size={16} className="feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && (
        <div className="key-moments-list">
          {moments.length === 0 ? (
            <p className="key-moments-empty text-sm text-muted">
              AI will detect key moments as the meeting progresses...
            </p>
          ) : (
            moments.map(moment => {
              const config = MOMENT_TYPES[moment.type] || MOMENT_TYPES.insight;
              return (
                <button
                  key={moment.id}
                  className="key-moment"
                  onClick={() => onJumpToSegment?.(moment.seqNo)}
                >
                  <div className="key-moment-header">
                    <span
                      className="key-moment-type text-xs font-medium"
                      style={{ color: config.color }}
                    >
                      {config.label}
                    </span>
                    <span className="key-moment-time text-mono text-xs">
                      {moment.timestamp}
                    </span>
                  </div>
                  <p className="key-moment-text text-sm">{moment.text}</p>
                  <div className="key-moment-footer">
                    <span className="key-moment-speaker text-xs text-muted">
                      {moment.speaker}
                    </span>
                    <div className="key-moment-actions">
                      <button
                        className={`key-moment-star ${moment.starred ? 'starred' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleStar(moment.id);
                        }}
                      >
                        {moment.starred ? <Star size={14} /> : <StarOff size={14} />}
                      </button>
                      <ExternalLink size={12} className="key-moment-link" />
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </Card>
  );
}
