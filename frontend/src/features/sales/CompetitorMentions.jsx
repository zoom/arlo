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

// Demo competitor data — Meridian Financial Group deal
const DEMO_COMPETITORS = [
  {
    id: 1,
    name: 'Snowflake',
    mentions: [
      {
        timestamp: '10:18:45 AM',
        seqNo: 32,
        text: 'Snowflake came in about 15% lower on their initial proposal, but their implementation timeline is longer.',
        sentiment: 'mixed',
      },
      {
        timestamp: '10:42:22 AM',
        seqNo: 78,
        text: 'The Snowflake team has been very responsive, I have to give them credit for that.',
        sentiment: 'positive',
      },
      {
        timestamp: '11:05:33 AM',
        seqNo: 112,
        text: 'Our concern with Snowflake is the consumption-based pricing — it\'s hard to predict costs.',
        sentiment: 'negative',
      },
    ],
    overallSentiment: 'mixed',
  },
  {
    id: 2,
    name: 'Databricks',
    mentions: [
      {
        timestamp: '10:28:15 AM',
        seqNo: 52,
        text: 'We looked at Databricks earlier but the learning curve for our team was too steep.',
        sentiment: 'negative',
      },
    ],
    overallSentiment: 'negative',
  },
  {
    id: 3,
    name: 'Legacy System',
    mentions: [
      {
        timestamp: '10:08:22 AM',
        seqNo: 15,
        text: 'Our current Oracle setup is costing us a fortune in maintenance and it can\'t handle the real-time requirements.',
        sentiment: 'negative',
      },
      {
        timestamp: '10:55:18 AM',
        seqNo: 98,
        text: 'The Oracle contract is up in June, so that\'s driving some of the urgency here.',
        sentiment: 'neutral',
      },
    ],
    overallSentiment: 'negative',
  },
];

const WATCH_LIST = ['Snowflake', 'Databricks', 'Legacy System', 'Azure Synapse', 'Google BigQuery', 'AWS Redshift'];

const SENTIMENT_CONFIG = {
  positive: { icon: TrendingUp, color: '#10b981', label: 'Positive' },
  negative: { icon: TrendingDown, color: '#ef4444', label: 'Negative' },
  neutral: { icon: Minus, color: '#6b7280', label: 'Neutral' },
  mixed: { icon: AlertTriangle, color: '#f59e0b', label: 'Mixed' },
};

export default function CompetitorMentions({ segments, onJumpToSegment, showDemoData = true }) {
  const [competitors] = useState(showDemoData ? DEMO_COMPETITORS : []);
  const [watchList, setWatchList] = useState(showDemoData ? WATCH_LIST : []);
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
