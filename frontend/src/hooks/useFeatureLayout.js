import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

/**
 * Feature Layout Context
 *
 * Manages feature card collapse states and custom ordering.
 * Features can be toggled between "expanded" (full content) and "collapsed" (header only).
 * User preferences are persisted to localStorage.
 */

const FeatureLayoutContext = createContext(null);

// Default feature order for each vertical
const DEFAULT_FEATURE_ORDER = {
  healthcare: [
    'clinical-alerts',
    'patient-context',
    'previous-sessions',
    'soap-notes',
    'quick-actions',
  ],
  legal: [
    'contradiction-detector',
    'legal-terms',
    'billable-time',
    'exhibit-tracker',
    'privilege-markers',
  ],
  sales: [
    'qualification-signals',
    'competitor-mentions',
    'commitments',
    'deal-tracker',
  ],
  support: [
    'sentiment-meter',
    'escalation-alerts',
    'resolution-tracker',
    'agent-assist',
  ],
  general: [
    'meeting-summary',
    'key-moments',
    'decisions-log',
    'open-questions',
    'smart-bookmarks',
    'participant-stats',
  ],
};

export function FeatureLayoutProvider({ children }) {
  // Load saved collapse preferences from localStorage
  const [collapsedFeatures, setCollapsedFeatures] = useState(() => {
    try {
      const saved = localStorage.getItem('arlo-collapsed-features');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Load saved feature order from localStorage
  const [featureOrder, setFeatureOrder] = useState(() => {
    try {
      const saved = localStorage.getItem('arlo-feature-order');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Persist collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('arlo-collapsed-features', JSON.stringify(collapsedFeatures));
  }, [collapsedFeatures]);

  // Persist feature order to localStorage
  useEffect(() => {
    localStorage.setItem('arlo-feature-order', JSON.stringify(featureOrder));
  }, [featureOrder]);

  // Check if a feature is collapsed
  const isCollapsed = useCallback((featureId) => {
    return collapsedFeatures[featureId] === true;
  }, [collapsedFeatures]);

  // Toggle collapse state for a feature
  const toggleCollapsed = useCallback((featureId) => {
    setCollapsedFeatures(prev => ({
      ...prev,
      [featureId]: prev[featureId] === true ? false : true,
    }));
  }, []);

  // Set collapse state explicitly
  const setCollapsed = useCallback((featureId, collapsed) => {
    setCollapsedFeatures(prev => ({
      ...prev,
      [featureId]: collapsed,
    }));
  }, []);

  // Expand all features
  const expandAll = useCallback(() => {
    setCollapsedFeatures({});
  }, []);

  // Get feature order for a vertical (returns default if no custom order)
  const getFeatureOrder = useCallback((verticalId) => {
    return featureOrder[verticalId] || DEFAULT_FEATURE_ORDER[verticalId] || [];
  }, [featureOrder]);

  // Update feature order for a vertical
  const updateFeatureOrder = useCallback((verticalId, newOrder) => {
    setFeatureOrder(prev => ({
      ...prev,
      [verticalId]: newOrder,
    }));
  }, []);

  // Reset feature order to default for a vertical
  const resetFeatureOrder = useCallback((verticalId) => {
    setFeatureOrder(prev => {
      const updated = { ...prev };
      delete updated[verticalId];
      return updated;
    });
  }, []);

  // Check if order has been customized for a vertical
  const hasCustomOrder = useCallback((verticalId) => {
    return !!featureOrder[verticalId];
  }, [featureOrder]);

  const value = {
    isCollapsed,
    toggleCollapsed,
    setCollapsed,
    expandAll,
    getFeatureOrder,
    updateFeatureOrder,
    resetFeatureOrder,
    hasCustomOrder,
    DEFAULT_FEATURE_ORDER,
  };

  return (
    <FeatureLayoutContext.Provider value={value}>
      {children}
    </FeatureLayoutContext.Provider>
  );
}

export function useFeatureLayout() {
  const context = useContext(FeatureLayoutContext);
  if (!context) {
    throw new Error('useFeatureLayout must be used within a FeatureLayoutProvider');
  }
  return context;
}
