import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, AlertCircle, Info, X, ChevronRight, Pill, Activity, Clock } from 'lucide-react';
import Card from '../../components/ui/Card';
import './ClinicalAlerts.css';

/**
 * ClinicalAlerts — Real-time warnings and alerts during patient encounters.
 *
 * Detects:
 * - Contradictions with previous sessions
 * - Drug interactions
 * - Allergy warnings
 * - Vital sign concerns
 * - Overdue screenings/follow-ups
 */

// Alert severity levels
const SEVERITY = {
  critical: { icon: AlertTriangle, color: '#dc2626', label: 'Critical' },
  warning: { icon: AlertCircle, color: '#f59e0b', label: 'Warning' },
  info: { icon: Info, color: '#0d9488', label: 'Info' },
};

// Demo alerts for testing — Maria Rodriguez chronic pain scenario
const DEMO_ALERTS = [
  {
    id: 1,
    type: 'allergy',
    severity: 'critical',
    title: 'NSAID Contraindication',
    message: 'Patient has documented GI bleeding history with NSAIDs. Avoid ibuprofen, naproxen, aspirin for pain management.',
    source: 'Allergy/adverse reaction record',
    timestamp: Date.now() - 60000, // 1 min ago
    dismissed: false,
  },
  {
    id: 2,
    type: 'drug_interaction',
    severity: 'warning',
    title: 'Serotonergic Interaction Risk',
    message: 'Duloxetine + Gabapentin: Low risk, but monitor for increased sedation. Counsel patient about driving/operating machinery.',
    source: 'Current medications',
    timestamp: Date.now() - 120000, // 2 min ago
    dismissed: false,
  },
  {
    id: 3,
    type: 'vital',
    severity: 'warning',
    title: 'Blood Pressure Above Target',
    message: 'BP 134/86 today. Per ADA guidelines, target BP for diabetic patients is <130/80. Consider Lisinopril adjustment or adding second agent.',
    source: 'Today\'s vitals + diabetes care guidelines',
    timestamp: Date.now() - 180000,
    dismissed: false,
  },
  {
    id: 4,
    type: 'screening',
    severity: 'info',
    title: 'Diabetic Foot Exam Due',
    message: 'Annual comprehensive foot exam overdue. Last completed: 13 months ago. Patient has neuropathic symptoms.',
    source: 'Preventive care schedule',
    timestamp: Date.now() - 240000,
    dismissed: false,
  },
  {
    id: 5,
    type: 'screening',
    severity: 'info',
    title: 'Diabetic Eye Exam Reminder',
    message: 'Annual dilated eye exam due in 2 months. Send referral to ophthalmology.',
    source: 'Preventive care schedule',
    timestamp: Date.now() - 300000,
    dismissed: false,
  },
];

function AlertIcon({ type }) {
  switch (type) {
    case 'drug_interaction':
      return <Pill size={14} />;
    case 'vital':
      return <Activity size={14} />;
    case 'screening':
      return <Clock size={14} />;
    default:
      return null;
  }
}

export default function ClinicalAlerts({ segments, patientInfo }) {
  const [alerts, setAlerts] = useState(DEMO_ALERTS);
  const [expandedAlert, setExpandedAlert] = useState(null);

  // Filter to show only non-dismissed alerts
  const activeAlerts = useMemo(() =>
    alerts.filter(a => !a.dismissed),
    [alerts]
  );

  // Group by severity for display
  const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical');
  const warningAlerts = activeAlerts.filter(a => a.severity === 'warning');
  const infoAlerts = activeAlerts.filter(a => a.severity === 'info');

  const dismissAlert = (id) => {
    setAlerts(prev => prev.map(a =>
      a.id === id ? { ...a, dismissed: true } : a
    ));
  };

  const dismissAll = () => {
    setAlerts(prev => prev.map(a => ({ ...a, dismissed: true })));
  };

  if (activeAlerts.length === 0) {
    return null; // Don't show if no alerts
  }

  return (
    <div className="clinical-alerts">
      <div className="clinical-alerts-header">
        <div className="clinical-alerts-title">
          <AlertTriangle size={16} className="clinical-alerts-icon" />
          <span className="text-sans font-medium">Clinical Alerts</span>
          <span className="clinical-alerts-count">{activeAlerts.length}</span>
        </div>
        {activeAlerts.length > 1 && (
          <button className="clinical-alerts-dismiss-all text-xs" onClick={dismissAll}>
            Dismiss All
          </button>
        )}
      </div>

      <div className="clinical-alerts-list">
        {/* Critical alerts first */}
        {criticalAlerts.map(alert => (
          <AlertItem
            key={alert.id}
            alert={alert}
            isExpanded={expandedAlert === alert.id}
            onToggle={() => setExpandedAlert(expandedAlert === alert.id ? null : alert.id)}
            onDismiss={() => dismissAlert(alert.id)}
          />
        ))}

        {/* Warning alerts */}
        {warningAlerts.map(alert => (
          <AlertItem
            key={alert.id}
            alert={alert}
            isExpanded={expandedAlert === alert.id}
            onToggle={() => setExpandedAlert(expandedAlert === alert.id ? null : alert.id)}
            onDismiss={() => dismissAlert(alert.id)}
          />
        ))}

        {/* Info alerts */}
        {infoAlerts.map(alert => (
          <AlertItem
            key={alert.id}
            alert={alert}
            isExpanded={expandedAlert === alert.id}
            onToggle={() => setExpandedAlert(expandedAlert === alert.id ? null : alert.id)}
            onDismiss={() => dismissAlert(alert.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AlertItem({ alert, isExpanded, onToggle, onDismiss }) {
  const severityConfig = SEVERITY[alert.severity];
  const SeverityIcon = severityConfig.icon;

  return (
    <div
      className={`clinical-alert clinical-alert-${alert.severity}`}
      style={{ '--alert-color': severityConfig.color }}
    >
      <div className="clinical-alert-main">
        <button className="clinical-alert-summary" onClick={onToggle}>
          <SeverityIcon size={16} className="clinical-alert-severity-icon" />
          <span className="clinical-alert-title">{alert.title}</span>
          <ChevronRight
            size={14}
            className={`clinical-alert-chevron ${isExpanded ? 'expanded' : ''}`}
          />
        </button>
        <button
          className="clinical-alert-dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          title="Dismiss alert"
        >
          <X size={14} />
        </button>
      </div>

      {isExpanded && (
        <div className="clinical-alert-details">
          <p className="clinical-alert-message">{alert.message}</p>
          <div className="clinical-alert-meta">
            <span className="text-xs text-muted">Source: {alert.source}</span>
          </div>
        </div>
      )}
    </div>
  );
}
