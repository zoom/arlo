import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import Card from '../../components/ui/Card';
import './SentimentMeter.css';

/**
 * SentimentMeter — Real-time customer sentiment visualization.
 *
 * Analyzes live transcript segments for sentiment-indicating keywords
 * and updates the meter in real-time. Reacts to actual speech during demos.
 */

const SENTIMENT_LEVELS = [
  { id: 'angry', label: 'Angry', emoji: '😠', color: '#dc2626', position: 0 },
  { id: 'frustrated', label: 'Frustrated', emoji: '😤', color: '#f97316', position: 25 },
  { id: 'neutral', label: 'Neutral', emoji: '😐', color: '#6b7280', position: 50 },
  { id: 'satisfied', label: 'Satisfied', emoji: '🙂', color: '#22c55e', position: 75 },
  { id: 'happy', label: 'Happy', emoji: '😊', color: '#10b981', position: 100 },
];

// Keyword patterns for sentiment detection (case-insensitive)
const SENTIMENT_KEYWORDS = {
  angry: [
    'unacceptable', 'angry', 'furious', 'ridiculous', 'outrageous',
    'cancel', 'lawsuit', 'lawyer', 'sue', 'terrible', 'worst',
    'hate', 'disgusted', 'appalling', 'inexcusable', 'demand',
  ],
  frustrated: [
    'frustrated', 'frustrating', 'broken', 'not working', 'still waiting',
    'days', 'weeks', 'again', 'another', 'keeps happening', 'still',
    'annoying', 'annoyed', 'disappointed', 'waste of time', 'useless',
    'nobody', 'no one', 'can\'t believe', 'seriously', 'come on',
  ],
  satisfied: [
    'okay', 'ok', 'understand', 'got it', 'makes sense', 'I see',
    'good', 'fine', 'alright', 'sounds good', 'that works',
    'better', 'improving', 'progress', 'helpful',
  ],
  happy: [
    'happy', 'very happy', 'so happy', 'extremely happy', 'really happy',
    'thank', 'thanks', 'awesome', 'amazing', 'fantastic', 'wonderful',
    'great', 'excellent', 'perfect', 'love', 'appreciate', 'grateful',
    'incredible', 'brilliant', 'best', 'exceeded', 'impressed',
    'so helpful', 'really helpful', 'incredibly helpful', 'solved',
  ],
};

// Detect sentiment from text
function detectSentiment(text) {
  const lowerText = text.toLowerCase();

  // Check each sentiment level (most extreme first)
  for (const sentiment of ['angry', 'happy', 'frustrated', 'satisfied']) {
    const keywords = SENTIMENT_KEYWORDS[sentiment];
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return { sentiment, trigger: keyword };
      }
    }
  }

  return null; // No strong sentiment detected
}

export default function SentimentMeter({ segments, showDemoData = true }) {
  const [currentSentiment, setCurrentSentiment] = useState('neutral');
  const [previousSentiment, setPreviousSentiment] = useState('neutral');
  const [history, setHistory] = useState([]);
  const [isLiveDetecting, setIsLiveDetecting] = useState(false);
  const lastProcessedSeqNo = useRef(-1);
  const sentimentDecayTimeout = useRef(null);
  const currentSentimentRef = useRef('neutral');

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

  // Process new transcript segments for sentiment
  const processSegment = useCallback((segment) => {
    if (!segment.text) return;

    const detection = detectSentiment(segment.text);

    if (detection) {
      // Handle both timestamp formats: tStartMs (number) or timestamp (ISO string)
      const ts = segment.tStartMs || segment.timestamp;
      const timestamp = formatTime(typeof ts === 'number' ? ts : Date.parse(ts));

      setPreviousSentiment(currentSentimentRef.current);
      setCurrentSentiment(detection.sentiment);
      setIsLiveDetecting(true);

      // Add to history
      setHistory(prev => [
        ...prev.slice(-4), // Keep last 4
        {
          sentiment: detection.sentiment,
          timestamp,
          trigger: `"${segment.text.slice(0, 60)}${segment.text.length > 60 ? '...' : ''}"`,
        },
      ]);

      // Clear any existing decay timeout
      if (sentimentDecayTimeout.current) {
        clearTimeout(sentimentDecayTimeout.current);
      }

      // Decay back toward neutral after 30 seconds of no sentiment triggers
      sentimentDecayTimeout.current = setTimeout(() => {
        setPreviousSentiment(detection.sentiment);
        // Decay one step toward neutral
        const currentLevel = SENTIMENT_LEVELS.find(l => l.id === detection.sentiment);
        if (currentLevel && currentLevel.position < 50) {
          setCurrentSentiment('neutral'); // Was negative, go to neutral
        } else if (currentLevel && currentLevel.position > 50) {
          setCurrentSentiment('satisfied'); // Was very positive, settle to satisfied
        }
      }, 30000);
    }
  }, []);

  // Watch for new transcript segments
  useEffect(() => {
    if (!segments || segments.length === 0) {
      setIsLiveDetecting(false);
      return;
    }

    // Process only new segments (handle string/number seqNo)
    const newSegments = segments.filter(s => {
      const seqNo = Number(s.seqNo);
      return !isNaN(seqNo) && seqNo > lastProcessedSeqNo.current;
    });

    if (newSegments.length > 0) {
      // Process each new segment for sentiment
      newSegments.forEach(segment => {
        processSegment(segment);
      });
      // Update last processed to the highest seqNo
      const maxSeqNo = Math.max(...newSegments.map(s => Number(s.seqNo)));
      lastProcessedSeqNo.current = maxSeqNo;
    }
  }, [segments, processSegment]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (sentimentDecayTimeout.current) {
        clearTimeout(sentimentDecayTimeout.current);
      }
    };
  }, []);

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
          {isLiveDetecting ? (
            <span className="feature-live-badge">Live</span>
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
            className="sentiment-gauge-indicator"
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
                  <span className="text-xs text-muted">{item.timestamp}</span>
                  <span className="text-xs">{item.trigger}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
