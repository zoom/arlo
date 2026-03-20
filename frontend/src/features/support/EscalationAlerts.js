import React, { useState } from 'react';
import { AlertTriangle, X, ExternalLink, Bell, BellOff, CheckCircle } from 'lucide-react';
import Card from '../../components/ui/Card';
import './EscalationAlerts.css';

/**
 * EscalationAlerts — Real-time detection of escalation triggers.
 *
 * Monitors conversation for phrases indicating customer frustration,
 * requests to escalate, or churn signals.
 */

const ESCALATION_TYPES = {
  manager: { label: 'Manager Request', color: '#dc2626', priority: 'high' },
  churn: { label: 'Churn Risk', color: '#f97316', priority: 'high' },
  frustration: { label: 'Frustration', color: '#eab308', priority: 'medium' },
  threat: { label: 'Threat', color: '#dc2626', priority: 'high' },
  repeat: { label: 'Repeat Issue', color: '#8b5cf6', priority: 'medium' },
};

// Demo escalation alerts — API integration issue scenario
const DEMO_ALERTS = [
  {
    id: 1,
    type: 'repeat',
    phrase: '"This is the third time I\'ve called about this integration issue"',
    timestamp: '2:15:22 PM',
    seqNo: 8,
    acknowledged: true,
  },
  {
    id: 2,
    type: 'frustration',
    phrase: '"This is costing us thousands in lost revenue every day"',
    timestamp: '2:18:45 PM',
    seqNo: 22,
    acknowledged: true,
  },
  {
    id: 3,
    type: 'churn',
    phrase: '"If we can\'t get this fixed, we\'ll have to look at other vendors"',
    timestamp: '2:20:12 PM',
    seqNo: 28,
    acknowledged: false,
  },
];

export default function EscalationAlerts({ segments, onJumpToSegment }) {
  const [alerts, setAlerts] = useState(DEMO_ALERTS);
  const [muted, setMuted] = useState(false);

  const activeAlerts = alerts.filter(a => !a.acknowledged);
  const acknowledgedAlerts = alerts.filter(a => a.acknowledged);

  const acknowledgeAlert = (alertId) => {
    setAlerts(prev => prev.map(a =>
      a.id === alertId ? { ...a, acknowledged: true } : a
    ));
  };

  const dismissAlert = (alertId) => {
    setAlerts(prev => prev.filter(a => a.id !== alertId));
  };

  return (
    <Card className="escalation-alerts">
      <div className="escalation-header">
        <div className="escalation-title">
          <AlertTriangle size={18} className="escalation-icon" />
          <h3 className="text-serif font-medium">Escalation Alerts</h3>
          {activeAlerts.length > 0 && (
            <span className="escalation-badge">{activeAlerts.length}</span>
          )}
        </div>
        <button
          className={`escalation-mute-btn ${muted ? 'muted' : ''}`}
          onClick={() => setMuted(!muted)}
          title={muted ? 'Unmute alerts' : 'Mute alerts'}
        >
          {muted ? <BellOff size={16} /> : <Bell size={16} />}
        </button>
      </div>

      {/* Active alerts */}
      {activeAlerts.length > 0 && (
        <div className="escalation-active">
          {activeAlerts.map(alert => {
            const config = ESCALATION_TYPES[alert.type];
            return (
              <div
                key={alert.id}
                className={`escalation-alert ${alert.type} ${config.priority}`}
                style={{ '--alert-color': config.color }}
              >
                <div className="escalation-alert-header">
                  <div className="escalation-alert-type">
                    <AlertTriangle size={14} />
                    <span className="text-xs font-medium">{config.label}</span>
                  </div>
                  <span className="escalation-alert-time text-mono text-xs">
                    {alert.timestamp}
                  </span>
                </div>
                <p className="escalation-alert-phrase text-sm">
                  {alert.phrase}
                </p>
                <div className="escalation-alert-actions">
                  <button
                    className="escalation-action-btn acknowledge"
                    onClick={() => acknowledgeAlert(alert.id)}
                  >
                    <CheckCircle size={12} />
                    Acknowledge
                  </button>
                  <button
                    className="escalation-action-btn jump"
                    onClick={() => onJumpToSegment?.(alert.seqNo)}
                  >
                    <ExternalLink size={12} />
                    View
                  </button>
                  <button
                    className="escalation-action-btn dismiss"
                    onClick={() => dismissAlert(alert.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* No active alerts */}
      {activeAlerts.length === 0 && (
        <div className="escalation-empty">
          <CheckCircle size={20} className="text-muted" />
          <span className="text-sm text-muted">No active escalation alerts</span>
        </div>
      )}

      {/* Acknowledged alerts (collapsed) */}
      {acknowledgedAlerts.length > 0 && (
        <div className="escalation-acknowledged">
          <span className="escalation-acknowledged-label text-xs text-muted">
            {acknowledgedAlerts.length} acknowledged
          </span>
          <div className="escalation-acknowledged-dots">
            {acknowledgedAlerts.map(alert => {
              const config = ESCALATION_TYPES[alert.type];
              return (
                <div
                  key={alert.id}
                  className="escalation-acknowledged-dot"
                  style={{ background: config.color }}
                  title={`${config.label}: ${alert.phrase}`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Monitored phrases hint */}
      <div className="escalation-hint">
        <span className="text-xs text-muted">
          Monitoring: manager requests, cancellation mentions, frustration signals
        </span>
      </div>
    </Card>
  );
}
