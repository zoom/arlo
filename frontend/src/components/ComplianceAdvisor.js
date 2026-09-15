import React, { useState } from 'react';
import {
  Shield,
  AlertTriangle,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronUp,
  X,
  CheckCircle,
} from 'lucide-react';
import Card from './ui/Card';
import { useComplianceDetection } from '../hooks/useComplianceDetection';
import './ComplianceAdvisor.css';

/**
 * ComplianceAdvisor - Real-time compliance monitoring panel
 *
 * Displays alerts based on vertical-specific compliance rules.
 * Scans transcript in real-time for potential compliance issues.
 */

const SEVERITY_CONFIG = {
  critical: {
    icon: AlertTriangle,
    label: 'Critical',
    color: '#dc2626',
    bgColor: 'rgba(220, 38, 38, 0.1)',
    borderColor: 'rgba(220, 38, 38, 0.3)',
  },
  warning: {
    icon: AlertCircle,
    label: 'Warning',
    color: '#f59e0b',
    bgColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  info: {
    icon: Info,
    label: 'Info',
    color: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
  },
};

const VERTICAL_LABELS = {
  healthcare: 'Healthcare Compliance',
  legal: 'Legal Compliance',
  sales: 'Sales Compliance',
  support: 'Support Compliance',
  notes: 'General Compliance',
};

export default function ComplianceAdvisor({
  segments,
  vertical = 'notes',
  enabled = true,
  defaultCollapsed = false,
}) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [expandedAlerts, setExpandedAlerts] = useState(new Set());

  const {
    alerts,
    alertSummary,
    dismissAlert,
    dismissAll,
    hasAlerts,
    hasCritical,
  } = useComplianceDetection(segments, vertical, enabled);

  if (!enabled) return null;

  const toggleAlert = (alertId) => {
    setExpandedAlerts(prev => {
      const next = new Set(prev);
      if (next.has(alertId)) {
        next.delete(alertId);
      } else {
        next.add(alertId);
      }
      return next;
    });
  };

  const formatTime = (ms) => {
    const date = new Date(ms);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <Card className={`compliance-advisor ${hasCritical ? 'has-critical' : ''}`}>
      <button
        className="compliance-advisor-header"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-expanded={!isCollapsed}
      >
        <div className="compliance-advisor-title">
          <Shield size={18} className="compliance-advisor-icon" />
          <h3 className="text-serif font-medium">
            {VERTICAL_LABELS[vertical] || 'Compliance Advisor'}
          </h3>
          {hasAlerts ? (
            <div className="compliance-badges">
              {alertSummary.critical > 0 && (
                <span className="compliance-badge critical">
                  {alertSummary.critical}
                </span>
              )}
              {alertSummary.warning > 0 && (
                <span className="compliance-badge warning">
                  {alertSummary.warning}
                </span>
              )}
              {alertSummary.info > 0 && (
                <span className="compliance-badge info">
                  {alertSummary.info}
                </span>
              )}
            </div>
          ) : (
            <span className="compliance-status-ok">
              <CheckCircle size={14} />
              Clear
            </span>
          )}
        </div>
        <div className="compliance-header-right">
          {hasAlerts && !isCollapsed && (
            <button
              className="compliance-dismiss-all"
              onClick={(e) => {
                e.stopPropagation();
                dismissAll();
              }}
            >
              Dismiss All
            </button>
          )}
          {isCollapsed ? (
            <ChevronDown size={18} className="compliance-chevron" />
          ) : (
            <ChevronUp size={18} className="compliance-chevron" />
          )}
        </div>
      </button>

      {!isCollapsed && (
        <div className="compliance-advisor-content">
          {!hasAlerts ? (
            <div className="compliance-empty">
              <CheckCircle size={24} className="compliance-empty-icon" />
              <p className="text-sans text-sm text-muted">
                No compliance issues detected. Monitoring in real-time...
              </p>
            </div>
          ) : (
            <div className="compliance-alerts">
              {alerts.map((alert) => {
                const config = SEVERITY_CONFIG[alert.severity];
                const Icon = config.icon;
                const isExpanded = expandedAlerts.has(alert.id);

                return (
                  <div
                    key={alert.id}
                    className={`compliance-alert ${alert.severity}`}
                    style={{
                      '--alert-color': config.color,
                      '--alert-bg': config.bgColor,
                      '--alert-border': config.borderColor,
                    }}
                  >
                    <div className="compliance-alert-header">
                      <button
                        className="compliance-alert-main"
                        onClick={() => toggleAlert(alert.id)}
                      >
                        <Icon size={16} className="compliance-alert-icon" />
                        <div className="compliance-alert-text">
                          <span className="compliance-alert-category text-xs">
                            {alert.category}
                          </span>
                          <span className="compliance-alert-message text-sm font-medium">
                            {alert.message}
                          </span>
                        </div>
                        <ChevronDown
                          size={14}
                          className={`compliance-expand-icon ${isExpanded ? 'expanded' : ''}`}
                        />
                      </button>
                      <button
                        className="compliance-alert-dismiss"
                        onClick={() => dismissAlert(alert.id)}
                        aria-label="Dismiss alert"
                      >
                        <X size={14} />
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="compliance-alert-details">
                        <div className="compliance-alert-trigger">
                          <span className="text-xs text-muted">Triggered by:</span>
                          <span className="compliance-trigger-text text-sm">
                            "{alert.trigger}"
                          </span>
                        </div>
                        <div className="compliance-alert-context">
                          <span className="text-xs text-muted">
                            {alert.segment.speaker} at {formatTime(alert.segment.timestamp)}
                          </span>
                          <p className="compliance-context-text text-xs">
                            "{alert.segment.text}"
                          </p>
                        </div>
                        <div className="compliance-alert-suggestion">
                          <span className="text-xs font-medium">Suggestion:</span>
                          <p className="text-xs text-muted">{alert.suggestion}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
