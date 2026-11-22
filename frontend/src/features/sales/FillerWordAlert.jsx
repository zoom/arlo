import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, VolumeX, AlertCircle, RotateCcw, Settings2 } from 'lucide-react';
import Card from '../../components/ui/Card';
import './FillerWordAlert.css';

/**
 * FillerWordAlert - Real-time filler word detection with audio alerts.
 *
 * Detects filler words like "so," "like," "you know," "basically" in real-time
 * and plays a subtle beep to help improve speaking cadence during pitches.
 */

const DEFAULT_FILLER_WORDS = [
  'so',
  'like',
  'you know',
  'basically',
  'actually',
  'literally',
  'um',
  'uh',
  'er',
  'ah',
  'right',
  'okay so',
  'i mean',
  'kind of',
  'sort of',
];

// Create audio context for beep generation
let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

function playBeep(frequency = 800, duration = 100, volume = 0.3) {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration / 1000);
  } catch (e) {
    console.warn('Could not play beep:', e);
  }
}

export default function FillerWordAlert({ segments = [], showDemoData = true }) {
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [fillerWords, setFillerWords] = useState(DEFAULT_FILLER_WORDS);
  const [detections, setDetections] = useState([]);
  const [stats, setStats] = useState({});
  const [lastAlert, setLastAlert] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [customWord, setCustomWord] = useState('');
  const processedSegments = useRef(new Set());
  const alertTimeoutRef = useRef(null);

  // Process new segments for filler words
  useEffect(() => {
    if (!segments || segments.length === 0) return;

    segments.forEach(segment => {
      // Skip already processed segments
      const segmentKey = segment.seqNo || segment.id || segment.text;
      if (processedSegments.current.has(segmentKey)) return;
      processedSegments.current.add(segmentKey);

      const text = (segment.text || '').toLowerCase();

      fillerWords.forEach(filler => {
        const regex = new RegExp(`\\b${filler}\\b`, 'gi');
        const matches = text.match(regex);

        if (matches) {
          matches.forEach(() => {
            const detection = {
              word: filler,
              timestamp: segment.timestamp || new Date().toLocaleTimeString(),
              text: segment.text,
              seqNo: segment.seqNo,
            };

            setDetections(prev => [...prev.slice(-49), detection]); // Keep last 50
            setStats(prev => ({
              ...prev,
              [filler]: (prev[filler] || 0) + 1,
            }));

            // Trigger alert
            if (alertsEnabled) {
              playBeep(800, 80, 0.2);
              setLastAlert(filler);

              // Clear alert highlight after animation
              if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
              alertTimeoutRef.current = setTimeout(() => setLastAlert(null), 500);
            }
          });
        }
      });
    });
  }, [segments, fillerWords, alertsEnabled]);

  // Demo mode: simulate detections
  useEffect(() => {
    if (!showDemoData || segments.length > 0) return;

    const demoStats = {
      'so': 12,
      'like': 8,
      'you know': 5,
      'basically': 3,
      'um': 7,
      'actually': 4,
    };
    setStats(demoStats);

    const demoDetections = [
      { word: 'so', timestamp: '10:15:22 AM', text: 'So, let me walk you through our pricing...', seqNo: 15 },
      { word: 'like', timestamp: '10:18:45 AM', text: "It's like a complete solution for your team", seqNo: 28 },
      { word: 'basically', timestamp: '10:22:10 AM', text: 'Basically, this handles all your reporting needs', seqNo: 42 },
      { word: 'you know', timestamp: '10:25:33 AM', text: "You know, many customers have seen great results", seqNo: 55 },
      { word: 'um', timestamp: '10:28:15 AM', text: 'Um, the implementation takes about two weeks', seqNo: 68 },
    ];
    setDetections(demoDetections);
  }, [showDemoData, segments.length]);

  const resetStats = useCallback(() => {
    setStats({});
    setDetections([]);
    processedSegments.current.clear();
  }, []);

  const addCustomWord = useCallback(() => {
    const word = customWord.trim().toLowerCase();
    if (word && !fillerWords.includes(word)) {
      setFillerWords(prev => [...prev, word]);
      setCustomWord('');
    }
  }, [customWord, fillerWords]);

  const removeWord = useCallback((word) => {
    setFillerWords(prev => prev.filter(w => w !== word));
  }, []);

  const totalCount = Object.values(stats).reduce((sum, count) => sum + count, 0);
  const topFillers = Object.entries(stats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <Card className={`filler-word-alert ${lastAlert ? 'alert-flash' : ''}`}>
      <div className="filler-header">
        <div className="filler-title">
          <AlertCircle size={18} className="filler-icon" />
          <h3 className="text-serif font-medium">Filler Word Coach</h3>
          <span className="feature-live-badge">Live</span>
        </div>
        <div className="filler-controls">
          <button
            className="filler-control-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            <Settings2 size={16} />
          </button>
          <button
            className="filler-control-btn"
            onClick={resetStats}
            title="Reset counts"
          >
            <RotateCcw size={16} />
          </button>
          <button
            className={`filler-control-btn ${alertsEnabled ? 'active' : ''}`}
            onClick={() => setAlertsEnabled(!alertsEnabled)}
            title={alertsEnabled ? 'Mute alerts' : 'Enable alerts'}
          >
            {alertsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        </div>
      </div>

      {/* Alert indicator */}
      {lastAlert && (
        <div className="filler-alert-banner">
          <span className="filler-alert-word">"{lastAlert}"</span>
          <span className="filler-alert-label">detected</span>
        </div>
      )}

      {/* Total count */}
      <div className="filler-total">
        <span className="filler-total-count">{totalCount}</span>
        <span className="filler-total-label">filler words detected</span>
      </div>

      {/* Top fillers breakdown */}
      {topFillers.length > 0 && (
        <div className="filler-breakdown">
          <span className="filler-breakdown-label text-xs text-muted">Most frequent</span>
          <div className="filler-breakdown-list">
            {topFillers.map(([word, count]) => (
              <div key={word} className="filler-breakdown-item">
                <span className="filler-word-text">"{word}"</span>
                <div className="filler-word-bar">
                  <div
                    className="filler-word-bar-fill"
                    style={{ width: `${(count / topFillers[0][1]) * 100}%` }}
                  />
                </div>
                <span className="filler-word-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent detections */}
      {detections.length > 0 && (
        <div className="filler-recent">
          <span className="filler-recent-label text-xs text-muted">Recent</span>
          <div className="filler-recent-list">
            {detections.slice(-5).reverse().map((d, i) => (
              <div key={i} className="filler-recent-item">
                <span className="filler-recent-word">"{d.word}"</span>
                <span className="filler-recent-time text-mono text-xs">{d.timestamp}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div className="filler-settings">
          <span className="filler-settings-label text-xs text-muted">Tracked words</span>
          <div className="filler-word-tags">
            {fillerWords.map(word => (
              <span key={word} className="filler-word-tag">
                {word}
                <button
                  className="filler-word-remove"
                  onClick={() => removeWord(word)}
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="filler-add-word">
            <input
              type="text"
              value={customWord}
              onChange={(e) => setCustomWord(e.target.value)}
              placeholder="Add custom word..."
              className="filler-add-input"
              onKeyDown={(e) => e.key === 'Enter' && addCustomWord()}
            />
            <button
              className="filler-add-btn"
              onClick={addCustomWord}
              disabled={!customWord.trim()}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Tip */}
      <div className="filler-tip">
        <span className="text-xs text-muted">
          {alertsEnabled
            ? 'Audio alerts are on. A beep will sound when filler words are detected.'
            : 'Audio alerts are muted. Click the speaker icon to enable.'}
        </span>
      </div>
    </Card>
  );
}
