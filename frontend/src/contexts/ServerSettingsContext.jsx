import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';

const ServerSettingsContext = createContext();

/**
 * Default feature flags for demo mode
 */
const defaultFeatures = {
  liveTranscription: true,
  realtimeAISuggestions: true,
  demoData: true,
  meetingHistory: false,
  search: false,
  upcomingMeetings: false,
  autoOpen: false,
  aiChat: false,
  autoStart: false,
  ownStream: false,
  // The deployment's GitHub repository ("owner/name"), where Arlo opens an issue; none by default
  github: { repo: null },
};

export function ServerSettingsProvider({ children }) {
  const [settings, setSettings] = useState({
    demoMode: true, // Default to demo mode
    meetingPersistenceEnabled: false,
    features: defaultFeatures,
    privacyNotice: '',
    loaded: false,
  });

  // Read again when someone signs in or out: the server tells the
  // deployment's GitHub repository only to a request with a valid session
  const { isAuthenticated } = useAuth();
  useEffect(() => {
    let cancelled = false;
    // Signed out: what only a signed-in person is told goes at once
    if (!isAuthenticated) {
      setSettings((prev) => (prev.features?.github?.repo
        ? { ...prev, features: { ...prev.features, github: { repo: null } } }
        : prev));
    }
    async function fetchSettings() {
      try {
        const response = await fetch('/api/auth/settings', { credentials: 'include' });
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          if (cancelled) return;
          setSettings({
            demoMode: data.demoMode ?? true,
            meetingPersistenceEnabled: data.meetingPersistenceEnabled ?? false,
            features: { ...defaultFeatures, ...(data.features || {}) },
            privacyNotice: data.privacyNotice ?? '',
            loaded: true,
          });
        }
      } catch {
        // Use defaults if fetch fails
        if (!cancelled) setSettings(prev => ({ ...prev, loaded: true }));
      }
    }
    fetchSettings();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const contextValue = useMemo(() => ({
    ...settings,
    // Helper to check if meeting history feature should be shown
    showMeetingHistory: settings.features?.meetingHistory ?? false,
    // Helper to check if search is available
    showSearch: settings.features?.search ?? false,
    // Helper to check if upcoming meetings is available
    showUpcomingMeetings: settings.features?.upcomingMeetings ?? false,
    // The deployment allows Arlo to request transcription when it is opened
    autoStartAvailable: settings.features?.autoStart === true,
    // The deployment offers "Take notes yourself" (a second stream in one meeting)
    ownStreamAvailable: settings.features?.ownStream === true,
  }), [settings]);

  return (
    <ServerSettingsContext.Provider value={contextValue}>
      {children}
    </ServerSettingsContext.Provider>
  );
}

export function useServerSettings() {
  const context = useContext(ServerSettingsContext);
  if (!context) {
    throw new Error('useServerSettings must be used within a ServerSettingsProvider');
  }
  return context;
}
