import React, { useState } from 'react';
import { Swords, AlertTriangle, TrendingUp, TrendingDown, Minus, ExternalLink, Plus, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import './CompetitorMentions.css';

/**
 * CompetitorMentions — Detect and track competitor mentions during sales calls.
 *
 * Features:
 * - Auto-detection of known competitors
 * - Sentiment analysis (positive/negative/neutral)
 * - Context snippets with timestamps
 * - Add custom competitors to watch list
 */

// Demo competitor data
const DEMO_COMPETITORS = [
  {
    id: 1,
    name: 'Competitor A',
    mentions: [
      {
        timestamp: '10:15:22 AM',
        seqNo: 28,
        text: 'We\'ve been evaluating Competitor A as well, but their pricing is quite high.',
        sentiment: 'negative',
      },
      {
        timestamp: '10:32:45 AM',
        seqNo: 56,
        text: 'Competitor A has a good reputation in the market.',
        sentiment: 'positive',
      },
    ],
    overallSentiment: 'mixed',
  },
  {
    id: 2,
    name: 'Competitor B',
    mentions: [
      {
        timestamp: '10:23:18 AM',
        seqNo: 42,
        text: 'We tried Competitor B last year but had issues with their support.',
        sentiment: 'negative',
      },
    ],
    overallSentiment: 'negative',
  },
  {
    id: 3,
    name: 'Competitor C',
    mentions: [
      {
        timestamp: '10:45:33 AM',
        seqNo: 78,
        text: 'How do you compare to Competitor C in terms of features?',
        sentiment: 'neutral',
      },
    ],
    overallSentiment: 'neutral',
  },
];

const WATCH_LIST = ['Competitor A', 'Competitor B', 'Competitor C', 'Competitor D', 'Legacy System'];

const SENTIMENT_CONFIG = {
  positive: { icon: TrendingUp, color: '#10b981', label: 'Positive' },
  negative: { icon: TrendingDown, color: '#ef4444', label: 'Negative' },
  neutral: { icon: Minus, color: '#6b7280', label: 'Neutral' },
  mixed: { icon: AlertTriangle, color: '#f59e0b', label: 'Mixed' },
};

export default function CompetitorMentions({ segments, onJumpToSegment }) {
  const [competitors] = useState(DEMO_COMPETITORS);
  const [watchList, setWatchList] = useState(WATCH_LIST);
  const [expandedId, setExpandedId] = useState(1);
  const [showAddCompetitor, setShowAddCompetitor] = useState(false);
  const [newCompetitor, setNewCompetitor] = useState('');

  const totalMentions = competitors.reduce((sum, c) => sum + c.mentions.length, 0);

  const addToWatchList = () => {
    if (!newCompetitor.trim() || watchList.includes(newCompetitor.trim())) return;
    setWatchList(prev => [...prev, newCompetitor.trim()]);
    setNewCompetitor('');
    setShowAddCompetitor(false);
  };

  const removeFromWatchList = (name) => {
    setWatchList(prev => prev.filter(c => c !== name));
  };

  return (
    <Card className="competitor-mentions">
      <div className="competitor-header">
        <div className="competitor-title">
          <Swords size={18} className="competitor-icon" />
          <h3 className="text-serif font-medium">Competitor Intel</h3>
          {totalMentions > 0 && (
            <span className="competitor-badge">{totalMentions} mentions</span>
          )}
        </div>
      </div>

      {/* Watch List */}
      <div className="competitor-watch-list">
        <div className="competitor-watch-header">
          <span className="text-xs text-muted font-medium">WATCHING</span>
          <button
            className="competitor-add-btn"
            onClick={() => setShowAddCompetitor(!showAddCompetitor)}
          >
            {showAddCompetitor ? <X size={12} /> : <Plus size={12} />}
          </button>
        </div>

        {showAddCompetitor && (
          <div className="competitor-add-form">
            <input
              type="text"
              placeholder="Add competitor..."
              value={newCompetitor}
              onChange={(e) => setNewCompetitor(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addToWatchList()}
              className="competitor-add-input"
              autoFocus
            />
            <button
              className="competitor-add-submit"
              onClick={addToWatchList}
              disabled={!newCompetitor.trim()}
            >
              Add
            </button>
          </div>
        )}

        <div className="competitor-watch-tags">
          {watchList.map(name => {
            const competitor = competitors.find(c => c.name === name);
            const hasMentions = competitor && competitor.mentions.length > 0;

            return (
              <div
                key={name}
                className={`competitor-watch-tag ${hasMentions ? 'mentioned' : ''}`}
              >
                <span>{name}</span>
                {hasMentions && (
                  <span className="competitor-watch-count">{competitor.mentions.length}</span>
                )}
                <button
                  className="competitor-watch-remove"
                  onClick={() => removeFromWatchList(name)}
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detected Mentions */}
      <div className="competitor-list">
        {competitors.length === 0 ? (
          <p className="competitor-empty text-sm text-muted">
            No competitor mentions detected yet.
          </p>
        ) : (
          competitors.map(competitor => {
            const isExpanded = expandedId === competitor.id;
            const sentimentConfig = SENTIMENT_CONFIG[competitor.overallSentiment];
            const SentimentIcon = sentimentConfig.icon;

            return (
              <div key={competitor.id} className="competitor-item">
                <button
                  className="competitor-item-header"
                  onClick={() => setExpandedId(isExpanded ? null : competitor.id)}
                >
                  <span className="competitor-name font-medium">{competitor.name}</span>
                  <div className="competitor-item-meta">
                    <span
                      className="competitor-sentiment"
                      style={{ color: sentimentConfig.color }}
                    >
                      <SentimentIcon size={14} />
                      {sentimentConfig.label}
                    </span>
                    <span className="competitor-count text-xs text-muted">
                      {competitor.mentions.length} mention{competitor.mentions.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="competitor-mentions-list">
                    {competitor.mentions.map((mention, i) => {
                      const mentionSentiment = SENTIMENT_CONFIG[mention.sentiment];

                      return (
                        <button
                          key={i}
                          className="competitor-mention"
                          onClick={() => onJumpToSegment?.(mention.seqNo)}
                        >
                          <div className="competitor-mention-header">
                            <span className="competitor-mention-time text-mono text-xs">
                              {mention.timestamp}
                            </span>
                            <span
                              className="competitor-mention-sentiment"
                              style={{ color: mentionSentiment.color }}
                            >
                              {mentionSentiment.label}
                            </span>
                          </div>
                          <p className="competitor-mention-text text-sm">
                            "{mention.text}"
                          </p>
                          <ExternalLink size={12} className="competitor-mention-link" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
