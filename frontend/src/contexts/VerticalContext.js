import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';

/**
 * Vertical definitions for Arlo
 * Each vertical customizes the AI prompts, features, and visual styling
 */
export const VERTICALS = {
  notes: {
    id: 'notes',
    name: 'Arlo for Notes',
    tagline: 'Meeting assistant & note-taker',
    icon: 'notes',
    accentColor: '#2563eb', // Blue (default)
    accentColorDark: '#3b82f6',
    features: ['actionItems', 'summary', 'topics', 'catchUp', 'search'],
    aiPromptPrefix: 'You are Arlo, an intelligent meeting assistant that helps capture key information from meetings.',
    terminology: {
      session: 'Meeting',
      participant: 'Participant',
      actionItem: 'Action Item',
    },
  },
  healthcare: {
    id: 'healthcare',
    name: 'Arlo for Healthcare',
    tagline: 'Clinical documentation assistant',
    icon: 'healthcare',
    accentColor: '#0d9488', // Teal
    accentColorDark: '#14b8a6',
    features: ['patientContext', 'soapNotes', 'symptoms', 'goals', 'medications', 'followUp'],
    aiPromptPrefix: 'You are Arlo, a clinical documentation assistant that helps healthcare providers capture patient encounters accurately and efficiently. Focus on clinical accuracy, HIPAA compliance, and structured documentation.',
    terminology: {
      session: 'Session',
      participant: 'Patient',
      actionItem: 'Follow-up Task',
    },
  },
  legal: {
    id: 'legal',
    name: 'Arlo for Legal',
    tagline: 'Legal transcription & analysis',
    icon: 'legal',
    accentColor: '#1e40af', // Navy
    accentColorDark: '#3b82f6',
    features: ['contradictions', 'keyTerms', 'timestamps', 'privilege', 'exhibits', 'export'],
    aiPromptPrefix: 'You are Arlo, a legal transcription assistant that helps attorneys and legal professionals capture depositions, client meetings, and hearings. Focus on accuracy, identifying key legal terms, and detecting contradictions in testimony.',
    terminology: {
      session: 'Proceeding',
      participant: 'Party',
      actionItem: 'Action Required',
    },
  },
  sales: {
    id: 'sales',
    name: 'Arlo for Sales',
    tagline: 'Sales coaching & deal intelligence',
    icon: 'sales',
    accentColor: '#059669', // Green
    accentColorDark: '#10b981',
    features: ['objections', 'talkRatio', 'sentiment', 'nextSteps', 'crmFields', 'coaching'],
    aiPromptPrefix: 'You are Arlo, a sales coaching assistant that helps sales professionals improve their calls and close more deals. Focus on identifying objections, tracking sentiment, and suggesting next steps.',
    terminology: {
      session: 'Call',
      participant: 'Prospect',
      actionItem: 'Next Step',
    },
  },
  finance: {
    id: 'finance',
    name: 'Arlo for Finance',
    tagline: 'Financial advisor compliance & insights',
    icon: 'finance',
    accentColor: '#7c3aed', // Purple
    accentColorDark: '#8b5cf6',
    features: ['compliance', 'clientGoals', 'riskTolerance', 'portfolioContext', 'secureExport'],
    aiPromptPrefix: 'You are Arlo, a financial advisor assistant that helps capture client meetings while maintaining compliance. Focus on client goals, risk tolerance, and regulatory requirements.',
    terminology: {
      session: 'Client Meeting',
      participant: 'Client',
      actionItem: 'Follow-up',
    },
  },
};

// Feature definitions with metadata
export const FEATURES = {
  // Notes vertical
  actionItems: { name: 'Action Items', description: 'Extract tasks and commitments' },
  summary: { name: 'Meeting Summary', description: 'AI-generated meeting overview' },
  topics: { name: 'Topic Detection', description: 'Identify discussion topics' },
  catchUp: { name: 'Catch-up Summary', description: '"What did I miss?" summaries' },
  search: { name: 'Transcript Search', description: 'Search within transcripts' },

  // Healthcare vertical
  patientContext: { name: 'Patient Context', description: 'Prior session history and notes' },
  soapNotes: { name: 'SOAP Notes', description: 'Auto-generate clinical documentation' },
  symptoms: { name: 'Symptom Tagging', description: 'Detect and tag symptom mentions' },
  goals: { name: 'Session Goals', description: 'Track treatment goals over time' },
  medications: { name: 'Medication Tracking', description: 'Flag medication discussions' },
  followUp: { name: 'Clinical Follow-ups', description: 'Next appointment tasks' },

  // Legal vertical
  contradictions: { name: 'Contradiction Detection', description: 'Flag conflicting statements' },
  keyTerms: { name: 'Legal Terms', description: 'Extract key legal terminology' },
  timestamps: { name: 'Certified Timestamps', description: 'Court-ready transcript timing' },
  privilege: { name: 'Privilege Markers', description: 'Attorney-client privilege flags' },
  exhibits: { name: 'Exhibit Linking', description: 'Reference document mentions' },
  export: { name: 'Legal Export', description: 'Formatted transcript export' },

  // Sales vertical
  objections: { name: 'Objection Tracker', description: 'Real-time objection detection' },
  talkRatio: { name: 'Talk-to-Listen Ratio', description: 'Speaking balance analysis' },
  sentiment: { name: 'Sentiment Trend', description: 'Customer mood tracking' },
  nextSteps: { name: 'Next Steps', description: 'Suggested follow-up actions' },
  crmFields: { name: 'CRM Fields', description: 'Auto-populate CRM data' },
  coaching: { name: 'Coaching Tips', description: 'Real-time selling suggestions' },

  // Finance vertical
  compliance: { name: 'Compliance Alerts', description: 'Regulatory violation flags' },
  clientGoals: { name: 'Client Goals', description: 'Track financial objectives' },
  riskTolerance: { name: 'Risk Assessment', description: 'Detect risk tolerance signals' },
  portfolioContext: { name: 'Portfolio Context', description: 'Prior meeting investment data' },
  secureExport: { name: 'Secure Export', description: 'Encrypted meeting records' },
};

const VerticalContext = createContext();

export function VerticalProvider({ children }) {
  // Initialize from localStorage or default to null (show selector)
  const [verticalId, setVerticalId] = useState(() => {
    try {
      const saved = localStorage.getItem('arlo-vertical');
      if (saved && VERTICALS[saved]) {
        return saved;
      }
    } catch {
      // localStorage unavailable
    }
    return null;
  });

  // Get the full vertical config
  const vertical = verticalId ? VERTICALS[verticalId] : null;

  // Persist to localStorage when changed
  useEffect(() => {
    if (verticalId) {
      try {
        localStorage.setItem('arlo-vertical', verticalId);
      } catch {
        // localStorage unavailable
      }

      // Apply vertical-specific accent color as CSS custom property
      const v = VERTICALS[verticalId];
      if (v) {
        document.documentElement.style.setProperty('--accent', v.accentColor);
        document.documentElement.style.setProperty('--accent-dark', v.accentColorDark);
        document.documentElement.style.setProperty('--ring', v.accentColor);

        // Set vertical-specific accent for features that need it
        if (verticalId === 'healthcare') {
          document.documentElement.style.setProperty('--healthcare-accent', v.accentColor);
        }
      }
    }
  }, [verticalId]);

  // Select a vertical
  const selectVertical = useCallback((id) => {
    if (VERTICALS[id]) {
      setVerticalId(id);
    }
  }, []);

  // Clear selection (return to selector)
  const clearVertical = useCallback(() => {
    setVerticalId(null);
    try {
      localStorage.removeItem('arlo-vertical');
    } catch {
      // localStorage unavailable
    }
    // Reset to default accent
    document.documentElement.style.setProperty('--accent', '#2563eb');
    document.documentElement.style.setProperty('--accent-dark', '#3b82f6');
    document.documentElement.style.setProperty('--ring', '#2563eb');
  }, []);

  // Check if a specific feature is enabled for the current vertical
  const hasFeature = useCallback((featureId) => {
    if (!vertical) return false;
    return vertical.features.includes(featureId);
  }, [vertical]);

  // Get terminology for the current vertical
  const getTerm = useCallback((key) => {
    if (!vertical) return key;
    return vertical.terminology[key] || key;
  }, [vertical]);

  const contextValue = useMemo(() => ({
    // Current vertical state
    verticalId,
    vertical,
    isVerticalSelected: !!verticalId,

    // All verticals for listing
    verticals: VERTICALS,
    features: FEATURES,

    // Actions
    selectVertical,
    clearVertical,

    // Helpers
    hasFeature,
    getTerm,
  }), [verticalId, vertical, selectVertical, clearVertical, hasFeature, getTerm]);

  return (
    <VerticalContext.Provider value={contextValue}>
      {children}
    </VerticalContext.Provider>
  );
}

export function useVertical() {
  const context = useContext(VerticalContext);
  if (!context) {
    throw new Error('useVertical must be used within a VerticalProvider');
  }
  return context;
}
