import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Zap, ExternalLink, Star, StarOff, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import { getPreferredAiModel, setPreferredAiModel } from '../../utils/aiModel';
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
const MOMENT_TYPE_ALIASES = {
  action: 'agreement',
  action_item: 'agreement',
  commitment: 'agreement',
  decision: 'agreement',
  decisions: 'agreement',
  issue: 'concern',
  problem: 'concern',
  risk: 'concern',
  blocker: 'concern',
  update: 'announcement',
  news: 'announcement',
  idea: 'insight',
  observation: 'insight',
  completion: 'milestone',
  progress: 'milestone',
};
const KEY_MOMENT_ANALYSIS_INTERVAL_MS = 30000;
const KEY_MOMENT_INITIAL_DELAY_MS = 3000;
const KEY_MOMENT_WINDOW_SEGMENTS = 12;
const KEY_MOMENT_MIN_CHARS = 40;
const KEY_MOMENT_GENERIC_FALLBACK_CHARS = 160;

const HEURISTIC_PATTERNS = [
  {
    type: 'agreement',
    patterns: [
      /\b(agree|agreed|consensus|decided|decision|approved|committed|commitment)\b/i,
      /\b(we|i)\s+(will|should|need to|must|have to)\b/i,
    ],
  },
  {
    type: 'concern',
    patterns: [
      /\b(risk|issue|problem|concern|blocked|blocker|delay|delayed|missing|broken|fail|failed|failure)\b/i,
    ],
  },
  {
    type: 'announcement',
    patterns: [
      /\b(announce|announcement|launch|released|release|go live|deadline|important update)\b/i,
    ],
  },
  {
    type: 'milestone',
    patterns: [
      /\b(completed|finished|done|milestone|shipped|delivered|resolved)\b/i,
    ],
  },
  {
    type: 'insight',
    patterns: [
      /\b(insight|realized|learned|discovered|opportunity|root cause|because|therefore)\b/i,
    ],
  },
];

function sentenceCandidates(text) {
  return text
    .split(/(?:\n|(?<=[.!?])\s+)/)
    .map((line) => line.replace(/^[^:\n]{1,40}:\s*/, '').trim())
    .filter((line) => line.length >= 20);
}

function detectKeyMomentHeuristic(text) {
  const candidates = sentenceCandidates(text);
  for (const candidate of candidates) {
    for (const rule of HEURISTIC_PATTERNS) {
      if (rule.patterns.some((pattern) => pattern.test(candidate))) {
        return {
          type: rule.type,
          text: candidate.slice(0, 100),
          confidence: 60,
          source: 'heuristic',
        };
      }
    }
  }
  return null;
}

function detectGenericMoment(text) {
  const candidates = sentenceCandidates(text);
  const candidate = candidates[candidates.length - 1];
  if (!candidate || candidate.length < 40) return null;
  return {
    type: 'insight',
    text: candidate.slice(0, 100),
    confidence: 35,
    source: 'local',
  };
}

function normalizeMomentType(type) {
  const key = String(type || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const normalized = MOMENT_TYPE_ALIASES[key] || key;
  return MOMENT_TYPES[normalized] ? normalized : null;
}

function normalizeMomentResult(result, text, allowGenericFallback = false) {
  const fallback = detectKeyMomentHeuristic(text) ||
    (allowGenericFallback ? detectGenericMoment(text) : null);

  if (!result || result.skip) return fallback;

  const type = normalizeMomentType(result.type || result.category || result.kind);
  const momentText = String(result.text || result.quote || result.summary || result.moment || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!type || !momentText) return fallback;

  const confidence = Number(result.confidence);
  return {
    type,
    text: momentText.slice(0, 100),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence)))
      : 50,
  };
}

function normalizeSegment(segment, index) {
  if (!segment?.text) return null;
  const rawSeqNo = segment.seqNo ?? segment.sequenceNumber ?? segment.sequence ?? segment.id;
  const numericSeqNo = Number(rawSeqNo);
  const rawTimestamp = segment.tStartMs ?? segment.timestamp ?? segment.createdAt;
  const numericTimestamp = Number(rawTimestamp);
  const parsedTimestamp = typeof rawTimestamp === 'string' ? Date.parse(rawTimestamp) : NaN;
  const order = Number.isFinite(numericSeqNo)
    ? numericSeqNo
    : Number.isFinite(numericTimestamp)
      ? numericTimestamp
      : parsedTimestamp;
  const seqNo = Number.isFinite(numericSeqNo)
    ? numericSeqNo
    : `live-${order}-${index}`;

  return {
    ...segment,
    seqNo,
    order: Number.isFinite(order) ? order : index,
    text: String(segment.text).trim(),
    speakerName: segment.speaker?.displayName ||
      segment.speaker?.label ||
      segment.speakerLabel ||
      segment.speakerName ||
      'Speaker',
  };
}

// Analyze segment for key moment using AI
async function analyzeKeyMomentAI(text, allowGenericFallback = false) {
  const response = await fetch('/api/ai/key-moment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text, model: getPreferredAiModel() }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || `Key moment API failed with status ${response.status}`);
  }

  if (result.modelUsed) setPreferredAiModel(result.modelUsed);
  return normalizeMomentResult(result, text, allowGenericFallback);
}

export default function KeyMoments({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('key-moments');
  const [moments, setMoments] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [lastSkippedAt, setLastSkippedAt] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);
  const lastAnalyzedSeqNo = useRef(-1);
  const latestSegmentsRef = useRef([]);
  const momentsRef = useRef([]);
  const inFlightRef = useRef(false);
  const seenMomentKeys = useRef(new Set());
  const momentIdCounter = useRef(1);

  useEffect(() => {
    latestSegmentsRef.current = segments || [];
  }, [segments]);
  useEffect(() => {
    momentsRef.current = moments;
  }, [moments]);

  const analyzeRecentWindow = useCallback(async () => {
    const currentSegments = latestSegmentsRef.current;
    if (inFlightRef.current || !currentSegments || currentSegments.length === 0) return;

    const orderedSegments = currentSegments
      .map(normalizeSegment)
      .filter(Boolean)
      .sort((left, right) => left.order - right.order);
    if (orderedSegments.length === 0) return;

    const latestSegment = orderedSegments[orderedSegments.length - 1];
    const latestSeqNo = latestSegment.order;
    if (latestSeqNo <= lastAnalyzedSeqNo.current) return;

    const windowSegments = orderedSegments.slice(-KEY_MOMENT_WINDOW_SEGMENTS);
    const text = windowSegments
      .map((segment) => `${segment.speakerName}: ${segment.text}`)
      .join('\n')
      .trim();

    if (text.length < KEY_MOMENT_MIN_CHARS) return;

    inFlightRef.current = true;
    setIsAnalyzing(true);
    setLastCheckedAt(Date.now());
    setAnalysisError(null);

    try {
      const allowGenericFallback = momentsRef.current.length === 0 &&
        text.length >= KEY_MOMENT_GENERIC_FALLBACK_CHARS;
      const result = await analyzeKeyMomentAI(text, allowGenericFallback);
      lastAnalyzedSeqNo.current = latestSeqNo;

      if (!result || !result.type || !MOMENT_TYPES[result.type]) {
        setLastSkippedAt(Date.now());
        return;
      }

      const momentKey = `${result.type}:${result.text}`.toLowerCase();
      if (seenMomentKeys.current.has(momentKey)) return;
      seenMomentKeys.current.add(momentKey);

      const sourceSegment = windowSegments[windowSegments.length - 1];
      const ts = sourceSegment.tStartMs || sourceSegment.timestamp;
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
        speaker: sourceSegment.speakerName,
        timestamp,
        seqNo: sourceSegment.seqNo,
        starred: false,
        confidence: result.confidence,
      };

      setMoments(prev => [...prev, newMoment]);
    } catch (error) {
      console.error('Key moment analysis failed:', error);
      setAnalysisError(error.message || 'Key moment analysis failed');
    } finally {
      inFlightRef.current = false;
      setIsAnalyzing(false);
    }
  }, []);

  // Analyze recent transcript context on a stable 30-second cadence.
  useEffect(() => {
    const initialTimer = setTimeout(analyzeRecentWindow, KEY_MOMENT_INITIAL_DELAY_MS);
    const interval = setInterval(analyzeRecentWindow, KEY_MOMENT_ANALYSIS_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [analyzeRecentWindow]);

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
              {isAnalyzing
                ? 'Analyzing recent transcript...'
                : analysisError
                  ? analysisError
                : lastSkippedAt
                  ? 'No key moment detected in the latest transcript window yet.'
                  : 'AI will detect key moments as the meeting progresses...'}
            </p>
          ) : (
            moments.map(moment => {
              const config = MOMENT_TYPES[moment.type] || MOMENT_TYPES.insight;
              return (
                <div
                  key={moment.id}
                  className="key-moment"
                  role="button"
                  tabIndex={0}
                  onClick={() => onJumpToSegment?.(moment.seqNo)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onJumpToSegment?.(moment.seqNo);
                    }
                  }}
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
                </div>
              );
            })
          )}
          {moments.length === 0 && lastCheckedAt && (
            <p className="key-moments-last-checked text-xs text-muted">
              Last checked {new Date(lastCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
              {lastSkippedAt ? ' — no key moment detected yet' : ''}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
