import { useState, useEffect, useRef, useCallback } from 'react';
import { getRulesForVertical } from '../services/complianceRules';

/**
 * useComplianceDetection - Real-time compliance monitoring hook
 *
 * Scans transcript segments against vertical-specific rules and returns alerts.
 *
 * @param {Array} segments - Transcript segments from the meeting
 * @param {string} vertical - Current vertical ('healthcare', 'legal', 'sales', 'support', 'notes')
 * @param {boolean} enabled - Whether compliance detection is enabled
 */
export function useComplianceDetection(segments, vertical, enabled = true) {
  const [alerts, setAlerts] = useState([]);
  const [dismissedAlerts, setDismissedAlerts] = useState(new Set());
  const processedSegments = useRef(new Set());
  const alertIdCounter = useRef(0);

  // Get rules for current vertical
  const rules = getRulesForVertical(vertical);

  /**
   * Check a single segment against all rules
   */
  const checkSegment = useCallback((segment) => {
    if (!segment?.text) return [];

    const text = segment.text.toLowerCase();
    const newAlerts = [];

    for (const rule of rules) {
      let matched = false;
      let matchedPhrase = '';

      // Check keywords
      if (rule.keywords) {
        for (const keyword of rule.keywords) {
          if (text.includes(keyword.toLowerCase())) {
            matched = true;
            matchedPhrase = keyword;
            break;
          }
        }
      }

      // Check regex patterns
      if (!matched && rule.patterns) {
        for (const pattern of rule.patterns) {
          const match = segment.text.match(pattern);
          if (match) {
            matched = true;
            matchedPhrase = match[0];
            break;
          }
        }
      }

      if (matched) {
        newAlerts.push({
          id: `${rule.id}-${alertIdCounter.current++}`,
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          message: rule.message,
          suggestion: rule.suggestion,
          trigger: matchedPhrase,
          segment: {
            text: segment.text,
            speaker: segment.speaker?.displayName || segment.speaker?.label || 'Speaker',
            timestamp: segment.tStartMs || Date.now(),
          },
          detectedAt: Date.now(),
        });
      }
    }

    return newAlerts;
  }, [rules]);

  /**
   * Process new segments
   */
  useEffect(() => {
    if (!enabled || !segments || segments.length === 0) return;

    const newAlerts = [];

    for (const segment of segments) {
      // Create unique key for segment
      const segKey = `${segment.seqNo || ''}-${segment.tStartMs || ''}-${segment.text?.slice(0, 20) || ''}`;

      // Skip already processed segments
      if (processedSegments.current.has(segKey)) continue;
      processedSegments.current.add(segKey);

      // Check segment against rules
      const segmentAlerts = checkSegment(segment);
      newAlerts.push(...segmentAlerts);
    }

    if (newAlerts.length > 0) {
      setAlerts(prev => [...prev, ...newAlerts]);
    }
  }, [segments, enabled, checkSegment]);

  /**
   * Reset when vertical changes
   */
  useEffect(() => {
    // Clear alerts when switching verticals
    setAlerts([]);
    setDismissedAlerts(new Set());
    processedSegments.current = new Set();
  }, [vertical]);

  /**
   * Dismiss a single alert
   */
  const dismissAlert = useCallback((alertId) => {
    setDismissedAlerts(prev => new Set([...prev, alertId]));
  }, []);

  /**
   * Dismiss all alerts
   */
  const dismissAll = useCallback(() => {
    setDismissedAlerts(prev => new Set([...prev, ...alerts.map(a => a.id)]));
  }, [alerts]);

  /**
   * Clear all alerts (including dismissed)
   */
  const clearAll = useCallback(() => {
    setAlerts([]);
    setDismissedAlerts(new Set());
  }, []);

  // Filter out dismissed alerts
  const activeAlerts = alerts.filter(a => !dismissedAlerts.has(a.id));

  // Group by severity for summary
  const alertSummary = {
    critical: activeAlerts.filter(a => a.severity === 'critical').length,
    warning: activeAlerts.filter(a => a.severity === 'warning').length,
    info: activeAlerts.filter(a => a.severity === 'info').length,
    total: activeAlerts.length,
  };

  return {
    alerts: activeAlerts,
    alertSummary,
    dismissAlert,
    dismissAll,
    clearAll,
    hasAlerts: activeAlerts.length > 0,
    hasCritical: alertSummary.critical > 0,
  };
}

export default useComplianceDetection;
