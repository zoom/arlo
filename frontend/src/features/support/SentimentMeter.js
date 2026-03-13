import React, { useState, useEffect } from 'react';
import { Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import Card from '../../components/ui/Card';
import './SentimentMeter.css';

/**
 * SentimentMeter — Real-time customer sentiment visualization.
 *
 * Shows a dynamic meter that shifts based on detected sentiment in the conversation.
 * Includes trend indicator and sentiment history.
 */

const SENTIMENT_LEVELS = [
  { id: 'angry', label: 'Angry', color: '#dc2626', position: 0 },
  { id: 'frustrated', label: 'Frustrated', color: '#f97316', position: 25 },
  { id: 'neutral', label: 'Neutral', color: '#6b7280', position: 50 },
  { id: 'satisfied', label: 'Satisfied', color: '#22c55e', position: 75 },
  { id: 'happy', label: 'Happy', color: '#10b981', position: 100 },
];

// Demo: Simulate sentiment changes over time
const DEMO_SENTIMENT_HISTORY = [
  { sentiment: 'frustrated', timestamp: '10:02:15 AM', trigger: 'Customer mentioned long wait time' },
  { sentiment: 'angry', timestamp: '10:04:32 AM', trigger: '"This is ridiculous" detected' },
  { sentiment: 'neutral', timestamp: '10:06:18 AM', trigger: 'Agent acknowledged the issue' },
  { sentiment: 'satisfied', timestamp: '10:08:45 AM', trigger: 'Solution offered and accepted' },
];

export default function SentimentMeter({ segments }) {
  const [currentSentiment, setCurrentSentiment] = useState('satisfied');
  const [previousSentiment, setPreviousSentiment] = useState('neutral');
  const [history] = useState(DEMO_SENTIMENT_HISTORY);

  // Demo: Cycle through sentiments to show the feature
  useEffect(() => {
    const sentiments = ['neutral', 'frustrated', 'angry', 'frustrated', 'neutral', 'satisfied', 'happy', 'satisfied'];
    let index = 4; // Start at satisfied

    const interval = setInterval(() => {
      setPreviousSentiment(sentiments[index]);
      index = (index + 1) % sentiments.length;
      setCurrentSentiment(sentiments[index]);
    }, 8000);

    return () => clearInterval(interval);
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
