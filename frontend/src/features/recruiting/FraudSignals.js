import React, { useState, useEffect, useMemo } from 'react';
import { Shield, AlertTriangle, CheckCircle, Eye, Globe, Clock, MessageSquare, Monitor } from 'lucide-react';
import Card from '../../components/ui/Card';
import './FraudSignals.css';

/**
 * FraudSignals — BrightHire-style candidate fraud detection panel.
 *
 * Displays subtle fraud indicators for interviewers (NEVER shown to candidates).
 * Important: This component surfaces evidence for human review — it never
 * auto-rejects or makes hiring decisions.
 *
 * Signals detected:
 * - Deepfake artifacts (rendering anomalies, face consistency)
 * - Answer timing patterns (unusually fast/scripted responses)
 * - Tab switching during technical questions
 * - VPN/proxy detection and location anomalies
 * - LLM-like answer patterns
 * - Audio anomalies (multiple voices, off-screen coaching)
 */

const SIGNAL_TYPES = {
  identity: {
    icon: Eye,
    label: 'Identity',
    description: 'Face and video consistency',
  },
  location: {
    icon: Globe,
    label: 'Location',
    description: 'IP and network signals',
  },
  timing: {
    icon: Clock,
    label: 'Timing',
    description: 'Response patterns',
  },
  content: {
    icon: MessageSquare,
    label: 'Content',
    description: 'Answer authenticity',
  },
  behavior: {
    icon: Monitor,
    label: 'Behavior',
    description: 'Tab and focus patterns',
  },
};

const STATUS_CONFIG = {
  clear: { color: '#10b981', label: 'Clear', bg: 'rgba(16, 185, 129, 0.1)' },
  review: { color: '#f59e0b', label: 'Review', bg: 'rgba(245, 158, 11, 0.1)' },
  flag: { color: '#ef4444', label: 'Flag', bg: 'rgba(239, 68, 68, 0.1)' },
  pending: { color: '#6b7280', label: 'Checking...', bg: 'rgba(107, 114, 128, 0.1)' },
};

// Simulated fraud detection (in production, this would come from backend/Zoom APIs)
function simulateFraudSignals(segments, meetingDurationMs) {
  // Default all clear for demo
  const signals = {
    identity: { status: 'clear', details: 'Video consistency normal', confidence: 98 },
    location: { status: 'clear', details: 'Location matches resume region', confidence: 95 },
    timing: { status: 'clear', details: 'Response timing natural', confidence: 92 },
    content: { status: 'clear', details: 'No LLM patterns detected', confidence: 88 },
    behavior: { status: 'clear', details: 'Normal focus patterns', confidence: 94 },
  };

  // In demo mode, occasionally show review/flag states for realism
  // This would be replaced with actual detection in production
  if (segments && segments.length > 20) {
    // Check for suspiciously fast, long responses (possible AI-assisted)
    const avgResponseLength = segments.reduce((sum, s) => sum + (s.text?.length || 0), 0) / segments.length;
    if (avgResponseLength > 200) {
      signals.content = {
        status: 'review',
        details: 'Unusually detailed responses — verify authenticity',
        confidence: 72,
      };
    }
  }

  return signals;
}

export default function FraudSignals({
  segments,
  meetingStartTime,
  showDemoData = true,
}) {
  const [signals, setSignals] = useState({});
  const [isExpanded, setIsExpanded] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  // Calculate meeting duration
  const meetingDurationMs = meetingStartTime ? Date.now() - meetingStartTime : 0;

  // Update signals periodically
  useEffect(() => {
    const updateSignals = () => {
      const newSignals = simulateFraudSignals(segments, meetingDurationMs);
      setSignals(newSignals);
      setLastChecked(new Date());
    };

    // Initial check
    updateSignals();

    // Re-check every 30 seconds
    const interval = setInterval(updateSignals, 30000);
    return () => clearInterval(interval);
  }, [segments, meetingDurationMs]);

  // Calculate overall status
  const overallStatus = useMemo(() => {
    const statuses = Object.values(signals).map(s => s.status);
    if (statuses.includes('flag')) return 'flag';
    if (statuses.includes('review')) return 'review';
    if (statuses.every(s => s === 'clear')) return 'clear';
    return 'pending';
  }, [signals]);

  const statusConfig = STATUS_CONFIG[overallStatus];
  const flagCount = Object.values(signals).filter(s => s.status === 'flag').length;
  const reviewCount = Object.values(signals).filter(s => s.status === 'review').length;

  return (
    <Card className="fraud-signals">
      <button
        className="fraud-signals-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="fraud-signals-title">
          <Shield size={18} className="fraud-icon" />
          <h3 className="text-serif font-medium">Fraud Signals</h3>
          <span
            className="fraud-status-badge"
            style={{ background: statusConfig.bg, color: statusConfig.color }}
          >
            {statusConfig.label}
          </span>
        </div>
        <div className="fraud-signals-summary">
          {flagCount > 0 && (
            <span className="fraud-count flag">{flagCount} flag{flagCount > 1 ? 's' : ''}</span>
          )}
          {reviewCount > 0 && (
            <span className="fraud-count review">{reviewCount} to review</span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="fraud-signals-content">
          {/* Disclaimer */}
          <div className="fraud-disclaimer">
            <AlertTriangle size={14} />
            <span className="text-xs">
              Signals are for human review only — never auto-reject based on flags
            </span>
          </div>

          {/* Signal Grid */}
          <div className="fraud-signal-grid">
            {Object.entries(SIGNAL_TYPES).map(([key, config]) => {
              const signal = signals[key] || { status: 'pending', details: 'Analyzing...', confidence: 0 };
              const Icon = config.icon;
              const status = STATUS_CONFIG[signal.status];

              return (
                <div
                  key={key}
                  className="fraud-signal-item"
                  style={{ '--signal-color': status.color }}
                >
                  <div className="fraud-signal-header">
                    <Icon size={16} />
                    <span className="text-sm font-medium">{config.label}</span>
                    <span
                      className="fraud-signal-status"
                      style={{ background: status.bg, color: status.color }}
                    >
                      {signal.status === 'clear' ? (
                        <CheckCircle size={12} />
                      ) : signal.status === 'flag' ? (
                        <AlertTriangle size={12} />
                      ) : null}
                      {status.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted">{signal.details}</p>
                  {signal.confidence > 0 && (
                    <div className="fraud-confidence">
                      <div className="fraud-confidence-bar">
                        <div
                          className="fraud-confidence-fill"
                          style={{ width: `${signal.confidence}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted">{signal.confidence}%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Last checked */}
          {lastChecked && (
            <p className="fraud-last-checked text-xs text-muted">
              Last checked: {lastChecked.toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
