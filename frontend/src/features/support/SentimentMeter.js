import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, TrendingUp, TrendingDown, Minus, Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import './SentimentMeter.css';

/**
 * SentimentMeter — Real-time AI-powered customer sentiment visualization.
 *
 * Uses AI to analyze customer speech for sentiment, handling:
 * - Negation ("not happy" = negative)
 * - Context and nuance
 * - Sarcasm and tone
 */

const SENTIMENT_LEVELS = [
  { id: 'angry', label: 'Angry', emoji: '😠', color: '#dc2626', position: 0 },
  { id: 'frustrated', label: 'Frustrated', emoji: '😤', color: '#f97316', position: 25 },
  { id: 'neutral', label: 'Neutral', emoji: '😐', color: '#6b7280', position: 50 },
  { id: 'satisfied', label: 'Satisfied', emoji: '🙂', color: '#22c55e', position: 75 },
  { id: 'happy', label: 'Happy', emoji: '😊', color: '#10b981', position: 100 },
];

// Analyze sentiment using AI
async function analyzeSentimentAI(text) {
  try {
    const response = await fetch('/api/ai/sentiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error('Sentiment API error:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Sentiment analysis failed:', error);
    return null;
  }
}

export default function SentimentMeter({ segments, showDemoData = true }) {
  const [currentSentiment, setCurrentSentiment] = useState('neutral');
  const [previousSentiment, setPreviousSentiment] = useState('neutral');
  const [history, setHistory] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const lastProcessedSeqNo = useRef(-1);
  const currentSentimentRef = useRef('neutral');
  const analysisQueue = useRef([]);
  const isProcessingQueue = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    currentSentimentRef.current = currentSentiment;
  }, [currentSentiment]);

  // Format timestamp from milliseconds
  const formatTime = (ms) => {
    const date = new Date(ms);
    if (isNaN(date.getTime()) || ms === 0) return '';
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Process queued segments with AI (debounced)
  const processQueue = useCallback(async () => {
    if (isProcessingQueue.current || analysisQueue.current.length === 0) return;

    isProcessingQueue.current = true;
    setIsAnalyzing(true);

    // Get the most recent segment to analyze
    const segment = analysisQueue.current.pop();
    analysisQueue.current = []; // Clear queue, we'll analyze the latest

    if (segment && segment.text) {
      const result = await analyzeSentimentAI(segment.text);

      if (result && result.sentiment) {
        // Handle timestamp
        const ts = segment.tStartMs || segment.timestamp;
        const timestamp = formatTime(typeof ts === 'number' ? ts : Date.parse(ts));

        setPreviousSentiment(currentSentimentRef.current);
        setCurrentSentiment(result.sentiment);
        setHasAnalyzed(true);

        // Add to history with AI's reasoning
        setHistory(prev => [
          ...prev.slice(-4),
          {
            sentiment: result.sentiment,
            timestamp,
            trigger: `"${segment.text.slice(0, 50)}${segment.text.length > 50 ? '...' : ''}"`,
            reason: result.reason,
            confidence: result.confidence,
          },
        ]);
      }
    }

    setIsAnalyzing(false);
    isProcessingQueue.current = false;

    // Process more if queue has items
    if (analysisQueue.current.length > 0) {
      setTimeout(processQueue, 500);
    }
  }, []);

  // Queue new segments for AI analysis
  const queueSegment = useCallback((segment) => {
    if (!segment.text || segment.text.trim().length < 3) return;

    analysisQueue.current.push(segment);

    // Debounce: wait 1 second before processing to batch rapid speech
    setTimeout(() => {
      processQueue();
    }, 1000);
  }, [processQueue]);

  // Watch for new transcript segments
  useEffect(() => {
    if (!segments || segments.length === 0) {
      return;
    }

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

  const currentLevel = SENTIMENT_LEVELS.find(l => l.id === currentSentiment) || SENTIMENT_LEVELS[2];
  const previousLevel = SENTIMENT_LEVELS.find(l => l.id === previousSentiment) || SENTIMENT_LEVELS[2];

  const getTrend = () => {
    if (currentLevel.position > previousLevel.position) return 'improving';
    if (currentLevel.position < previousLevel.position) return 'declining';
    return 'stable';
  };

  const trend = getTrend();

  return (
    <Card className="sentiment-meter">
      <div className="sentiment-header">
        <div className="sentiment-title">
          <Activity size={18} className="sentiment-icon" />
          <h3 className="text-serif font-medium">Customer Sentiment</h3>
          {isAnalyzing ? (
            <span className="sentiment-analyzing-badge">
              <Sparkles size={10} />
              Analyzing...
            </span>
          ) : hasAnalyzed ? (
            <span className="feature-live-badge">AI</span>
          ) : (
            <span className="sentiment-waiting-badge">Listening...</span>
          )}
        </div>
        <div className={`sentiment-trend ${trend}`}>
          {trend === 'improving' && <TrendingUp size={14} />}
          {trend === 'declining' && <TrendingDown size={14} />}
          {trend === 'stable' && <Minus size={14} />}
          <span className="text-xs font-medium">
            {trend === 'improving' ? 'Improving' : trend === 'declining' ? 'Declining' : 'Stable'}
          </span>
        </div>
      </div>

      {/* Main sentiment gauge */}
      <div className="sentiment-gauge">
        <div className="sentiment-gauge-track">
          <div className="sentiment-gauge-gradient" />
          <div
            className={`sentiment-gauge-indicator ${isAnalyzing ? 'analyzing' : ''}`}
            style={{
              left: `${currentLevel.position}%`,
              '--indicator-color': currentLevel.color
            }}
          >
            <div className="sentiment-gauge-dot" />
            <div className="sentiment-gauge-pulse" />
          </div>
        </div>
        <div className="sentiment-gauge-labels">
          {SENTIMENT_LEVELS.filter((_, i) => i % 2 === 0 || i === SENTIMENT_LEVELS.length - 1).map(level => (
            <span
              key={level.id}
              className="sentiment-gauge-label text-xs"
              style={{ color: level.color }}
            >
              {level.label}
            </span>
          ))}
        </div>
      </div>

      {/* Current sentiment display */}
      <div className="sentiment-current" style={{ '--sentiment-color': currentLevel.color }}>
        <span className="sentiment-current-emoji">{currentLevel.emoji}</span>
        <span className="sentiment-current-label text-sm">Current:</span>
        <span className="sentiment-current-value font-medium">{currentLevel.label}</span>
      </div>

      {/* Recent sentiment shifts */}
      <div className="sentiment-history">
        <span className="sentiment-history-label text-xs text-muted">Recent Shifts</span>
        <div className="sentiment-history-list">
          {history.slice(-3).reverse().map((item, i) => {
            const level = SENTIMENT_LEVELS.find(l => l.id === item.sentiment);
            return (
              <div key={i} className="sentiment-history-item">
                <div
                  className="sentiment-history-dot"
                  style={{ background: level?.color }}
                />
                <div className="sentiment-history-content">
                  <div className="sentiment-history-meta">
                    <span className="text-xs text-muted">{item.timestamp}</span>
                    {item.confidence && (
                      <span className="sentiment-confidence text-xs">{item.confidence}%</span>
                    )}
                  </div>
                  <span className="text-xs">{item.trigger}</span>
                  {item.reason && (
                    <span className="text-xs text-muted sentiment-reason">{item.reason}</span>
                  )}
                </div>
              </div>
            );
          })}
          {history.length === 0 && (
            <p className="text-xs text-muted" style={{ fontStyle: 'italic', padding: '8px 0' }}>
              AI will analyze customer sentiment as they speak...
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
